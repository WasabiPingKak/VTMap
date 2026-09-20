import logging
import os
import time
from datetime import UTC, datetime

import requests
from apiflask import APIBlueprint
from flask import jsonify
from google.api_core.exceptions import GoogleAPIError
from google.cloud.firestore import Client

from schemas.common import ChannelIdQuery
from utils.admin_auth import require_admin_key
from utils.cloud_tasks_client import dispatch_tasks_batch

websub_subscribe_bp = APIBlueprint("websub_subscribe", __name__, tag="WebSub")
HUB_URL = "https://pubsubhubbub.appspot.com/subscribe"
# hub 正常時 1 秒內回 202；故障時會卡約 20 秒才回 503，等它只是白白佔用運算時間
HUB_TIMEOUT_SECONDS = 5
# 派發前探測 hub 的頻道數上限，全部失敗才判定 hub 故障
HUB_PROBE_LIMIT = 3


def _get_callback_url() -> str:
    """每次呼叫時讀取環境變數，避免 module-level 快取導致 cold start 問題"""
    return os.getenv("WEBSUB_CALLBACK_URL", "")


def subscribe_channel_by_id(channel_id: str) -> bool:
    """
    可獨立呼叫的訂閱函式（Cloud Tasks 觸發或 API 單獨測試）
    """
    if not channel_id:
        logging.warning("❌ 呼叫 subscribe_channel_by_id 時缺少 channel_id")
        return False

    callback_url = _get_callback_url()
    if not callback_url:
        logging.error("❌ 未設定 WEBSUB_CALLBACK_URL 環境變數")
        return False

    topic = f"https://www.youtube.com/xml/feeds/videos.xml?channel_id={channel_id}"
    payload = {
        "hub.mode": "subscribe",
        "hub.topic": topic,
        "hub.callback": callback_url,
        "hub.verify": "async",
    }

    websub_secret = os.getenv("WEBSUB_SECRET", "")
    if websub_secret:
        payload["hub.secret"] = websub_secret

    logging.info(f"📡 單獨訂閱頻道：{channel_id}")
    try:
        response = requests.post(HUB_URL, data=payload, timeout=HUB_TIMEOUT_SECONDS)
        if response.status_code == 202:
            logging.info(f"✅ 訂閱成功：{channel_id}")
            return True
        else:
            logging.warning(f"❗訂閱失敗：{channel_id} → {response.status_code} - {response.text}")
            return False
    except requests.exceptions.RequestException:
        logging.error(f"🔥 單筆訂閱發生例外：{channel_id}", exc_info=True)
        return False


def _probe_hub(channel_ids: list[str]) -> tuple[bool, str | None]:
    """
    派發前確認 hub 是否正常：依序對前幾個頻道做真實訂閱（本來就要續訂，重複訂閱無副作用）。

    hub 故障時每個請求都會卡到逾時，整輪派發加上 Cloud Tasks 重試只會燒運算時間，
    幾乎沒有頻道能訂閱成功。所以探測全部失敗就由呼叫端略過本輪，等下一次排程再試。

    回傳 (hub 是否正常, 探測時已訂閱成功、不需再派發的 channel_id)
    """
    for channel_id in channel_ids[:HUB_PROBE_LIMIT]:
        if subscribe_channel_by_id(channel_id):
            return True, channel_id
    return False, None


def _log_job_result(db: Client, job_name: str, result: dict):
    """將排程任務執行結果寫入 Firestore scheduler_job_logs"""
    try:
        now = datetime.now(UTC)
        doc_id = f"{job_name}_{now.strftime('%Y%m%d_%H%M%S')}"
        db.collection("scheduler_job_logs").document(doc_id).set(
            {
                "job_name": job_name,
                "executed_at": now,
                "duration_seconds": result.get("duration_seconds"),
                "status": result.get("status"),
                "total_channels": result.get("total_channels", 0),
                "dispatched": result.get("dispatched", 0),
                "failed": result.get("failed", 0),
                "skipped": result.get("skipped", 0),
                "message": result.get("message"),
            }
        )
    except Exception:
        logging.error("🔥 寫入 scheduler_job_logs 失敗", exc_info=True)


def init_websub_subscribe_route(app, db: Client):
    @websub_subscribe_bp.route("/api/websub/subscribe-all", methods=["POST"])
    @websub_subscribe_bp.doc(
        summary="批次訂閱所有頻道",
        description="透過 Cloud Tasks 非同步派發所有頻道的 WebSub 訂閱",
        security="BearerAuth",
    )
    @require_admin_key
    def subscribe_all_channels():
        """
        讀取所有頻道，透過 Cloud Tasks 非同步派發訂閱任務。
        每個頻道獨立一個 task，不會因為數量多而 timeout。
        派發前會先探測 hub，故障時略過本輪並回 502。
        """
        start_time = time.monotonic()
        result = {
            "status": "success",
            "total_channels": 0,
            "dispatched": 0,
            "failed": 0,
            "skipped": 0,
        }

        try:
            callback_url = _get_callback_url()
            if not callback_url:
                result["status"] = "error"
                result["message"] = "未設定 WEBSUB_CALLBACK_URL 環境變數"
                logging.error(f"❌ {result['message']}")
                return jsonify(result), 400

            doc = db.collection("channel_sync_index").document("index_list").get()
            data = doc.to_dict() or {}  # type: ignore[union-attr]
            channels = data.get("channels", [])

            if not channels:
                result["status"] = "error"
                result["message"] = "無頻道資料可訂閱"
                return jsonify(result), 400

            # 過濾出有效的 channel_id
            valid_params = []
            for item in channels:
                channel_id = item.get("channel_id")
                if channel_id:
                    valid_params.append({"channel_id": channel_id})
                else:
                    result["skipped"] += 1  # type: ignore[operator]

            result["total_channels"] = len(channels)

            # 派發前先探測 hub，故障就略過本輪（理由見 _probe_hub）
            hub_ok, probed_channel_id = _probe_hub([p["channel_id"] for p in valid_params])
            if valid_params and not hub_ok:
                result["duration_seconds"] = round(time.monotonic() - start_time, 2)
                result["status"] = "skipped"
                result["message"] = (
                    f"WebSub hub 連續 {min(HUB_PROBE_LIMIT, len(valid_params))} 次訂閱失敗，"
                    "判定 hub 故障，略過本輪派發"
                )
                logging.error(f"🚫 websub subscribe-all：{result['message']}")
                _log_job_result(db, "websub-subscribe-all", result)
                # 回 502 讓 Cloud Scheduler 把這次執行標為失敗，方便從排程紀錄看出 hub 故障
                return jsonify(result), 502

            # 探測時已訂閱成功的頻道不需要再派發
            valid_params = [p for p in valid_params if p["channel_id"] != probed_channel_id]

            logging.info(
                f"📤 websub subscribe-all：準備派發 {len(valid_params)} 個 "
                f"Cloud Tasks（CALLBACK_URL={callback_url}）"
            )

            # 透過 Cloud Tasks 批次派發
            batch_result = dispatch_tasks_batch(
                "/api/websub/subscribe-one",
                params_list=valid_params,
            )
            result["dispatched"] = batch_result["dispatched"]
            result["failed"] = batch_result["failed"]

            result["duration_seconds"] = round(time.monotonic() - start_time, 2)
            result["status"] = "success" if result["failed"] == 0 else "partial"
            message = f"已派發 {result['dispatched']} 個訂閱任務，失敗 {result['failed']} 個"
            if probed_channel_id:
                message += "，另有 1 個頻道於探測 hub 時直接訂閱完成"
            result["message"] = message

            logging.info(f"✅ websub subscribe-all 完成：{result}")
            _log_job_result(db, "websub-subscribe-all", result)
            return jsonify(result), 200

        except GoogleAPIError:
            result["duration_seconds"] = round(time.monotonic() - start_time, 2)
            result["status"] = "error"
            result["message"] = "Firestore 操作失敗"
            logging.exception("🔥 Firestore 操作失敗")
            _log_job_result(db, "websub-subscribe-all", result)
            return jsonify(result), 500

        except Exception:
            result["duration_seconds"] = round(time.monotonic() - start_time, 2)
            result["status"] = "error"
            result["message"] = "訂閱派發過程發生錯誤"
            logging.exception("🔥 訂閱派發失敗")
            _log_job_result(db, "websub-subscribe-all", result)
            return jsonify(result), 500

    @websub_subscribe_bp.route("/api/websub/subscribe-one", methods=["POST"])
    @websub_subscribe_bp.doc(
        summary="訂閱單一頻道",
        description="訂閱單一頻道的 WebSub 推播，由 Cloud Tasks 呼叫",
        security="BearerAuth",
    )
    @require_admin_key
    @websub_subscribe_bp.input(ChannelIdQuery, location="query", arg_name="query")
    def subscribe_single_channel(query):
        """
        訂閱單一頻道。由 Cloud Tasks 呼叫（帶 Admin Key），也可手動測試。
        Cloud Tasks 會自動 retry 失敗的 task。
        """
        channel_id = query.channel_id

        success = subscribe_channel_by_id(channel_id)
        if success:
            return jsonify({"status": "ok", "channel_id": channel_id}), 200
        else:
            # 回傳 500 讓 Cloud Tasks 知道需要 retry
            return jsonify({"error": f"訂閱失敗：{channel_id}"}), 500

    app.register_blueprint(websub_subscribe_bp)
