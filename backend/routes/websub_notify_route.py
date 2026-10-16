import hashlib
import hmac
import logging
import os
from datetime import UTC, datetime

from apiflask import APIBlueprint
from defusedxml.ElementTree import fromstring as safe_xml_fromstring
from flask import Response, request
from google.cloud.firestore import Client

from services.discord_notify.config_store import is_notify_enabled
from services.discord_notify.processor import enqueue_video

websub_notify_bp = APIBlueprint("websub_notify", __name__, tag="WebSub")
COLLECTION_NAME = "live_redirect_notifications"


def _write_notify_item(db: Client, doc_id: str, new_item: dict):
    """直接寫入單筆 WebSub 通知，每筆通知為獨立 document，無需 transaction"""
    db.collection(COLLECTION_NAME).document(doc_id).set(new_item, merge=True)


def _enqueue_discord_notify(db: Client, video_id: str, channel_id: str, now: datetime):
    """有開 Discord 通知的頻道，排入通知佇列。失敗不影響原本的推播處理"""
    try:
        if is_notify_enabled(db, channel_id):
            enqueue_video(db, video_id, channel_id, now)
            logging.info(f"📨 已排入 Discord 通知佇列：{video_id}")
    except Exception:
        logging.error(f"🔥 排入 Discord 通知佇列失敗：{video_id}", exc_info=True)


def init_websub_notify_route(app, db: Client):
    @websub_notify_bp.route("/websub-callback", methods=["GET", "POST"])
    @websub_notify_bp.doc(
        summary="WebSub 回調",
        description="接收 YouTube WebSub 推播通知（新影片上傳）",
        hide=True,
    )
    def websub_callback():
        if request.method == "GET":
            # 驗證訂閱請求，回傳 hub.challenge
            hub_mode = request.args.get("hub.mode")
            hub_challenge = request.args.get("hub.challenge")
            hub_topic = request.args.get("hub.topic")
            logging.info(f"🔔 WebSub 驗證請求：mode={hub_mode}, topic={hub_topic}")
            if hub_challenge:
                return Response(hub_challenge, status=200, content_type="text/plain")
            return Response("Missing hub.challenge", status=400)

        elif request.method == "POST":
            try:
                xml_data = request.data

                # 驗證 Hub 簽名（若有設定 WEBSUB_SECRET）
                websub_secret = os.getenv("WEBSUB_SECRET", "")
                if websub_secret:
                    signature = request.headers.get("X-Hub-Signature", "")
                    expected = (
                        "sha1="
                        + hmac.new(websub_secret.encode(), xml_data, hashlib.sha1).hexdigest()
                    )
                    if not hmac.compare_digest(signature, expected):
                        logging.warning("⚠️ WebSub 簽名驗證失敗")
                        return Response("Invalid signature", status=403)
                root = safe_xml_fromstring(xml_data)

                # YouTube 推播的 XML 格式 namespace
                ns = {
                    "atom": "http://www.w3.org/2005/Atom",
                    "yt": "http://www.youtube.com/xml/schemas/2015",
                }
                entries = root.findall("atom:entry", ns)
                logging.info(f"📦 WebSub 接收到 {len(entries)} 筆新影片通知")

                for entry in entries:
                    video_id_elem = entry.find("yt:videoId", ns)
                    channel_id_elem = entry.find("yt:channelId", ns)
                    if video_id_elem is None or channel_id_elem is None:
                        logging.warning("⚠️ WebSub 通知缺少 videoId 或 channelId，略過")
                        continue
                    video_id = video_id_elem.text
                    channel_id = channel_id_elem.text
                    notified_at = datetime.now(UTC)
                    date_str = notified_at.date().isoformat()
                    doc_id = f"{date_str}_{video_id}"

                    logging.info(f"📺 通知影片 videoId={video_id}，channelId={channel_id}")

                    new_item = {
                        "videoId": video_id,
                        "channelId": channel_id,
                        "notifiedAt": notified_at.isoformat(),
                        "processedAt": None,
                        "date": date_str,
                    }
                    _write_notify_item(db, doc_id, new_item)
                    _enqueue_discord_notify(db, video_id, channel_id, notified_at)

                return Response("OK", status=204)
            except Exception:
                logging.error("🔥 WebSub 推播處理失敗", exc_info=True)
                return Response("Internal Server Error", status=500)

        return Response("Method Not Allowed", status=405)

    app.register_blueprint(websub_notify_bp)
