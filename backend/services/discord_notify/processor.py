# services/discord_notify/processor.py
# Discord 通知主流程：消化 WebSub 佇列、追蹤待機室、發送通知
#
# 由 Cloud Scheduler 每分鐘呼叫 run_tick()。
# 所有待查影片合併成批次查詢（一次最多 50 支，只花 1 單位 quota）。

import logging
from datetime import datetime, timedelta

from google.api_core.exceptions import AlreadyExists
from google.cloud.firestore import Client

from services.discord_notify.classifier import (
    ACTION_NOTIFY,
    ACTION_WAIT,
    KIND_LIVE,
    KIND_VIDEO,
    LABEL_LIVE,
    LABEL_SHORTS,
    LABEL_VIDEO,
    Decision,
    classify_for_notify,
)
from services.discord_notify.config_store import get_config, render_message
from services.discord_notify.discord_api import send_message
from services.live_redirect.youtube_api import batch_fetch_video_details
from utils.exceptions import AppError

QUEUE_COLLECTION = "discord_notify_queue"
PENDING_COLLECTION = "discord_notify_pending"
SENT_COLLECTION = "discord_notify_sent"

FETCH_PARTS = "snippet,liveStreamingDetails,contentDetails,status"

# 預定時間前 2 小時開始檢查待機室（實測曾提早 35 分鐘開台）。
# 每分鐘的查詢會合併成一批，拉長視窗只增加少量 quota
PENDING_LEAD = timedelta(hours=2)
# 預定時間過了 6 小時還沒開台，視為放棄的待機室
PENDING_EXPIRE = timedelta(hours=6)
# 發送失敗的重試上限（每分鐘一次）
MAX_ATTEMPTS = 5

RESULT_SENT = "sent"
RESULT_DUPLICATE = "duplicate"
RESULT_DISABLED = "disabled"
RESULT_FAILED = "failed"


def enqueue_video(db: Client, video_id: str, channel_id: str, now: datetime) -> None:
    """WebSub 收到推播時呼叫，排入下一次 tick 處理"""
    db.collection(QUEUE_COLLECTION).document(video_id).set(
        {"videoId": video_id, "channelId": channel_id, "notifiedAt": now}, merge=True
    )


def build_context(item: dict, label: str) -> dict:
    video_id = item.get("id", "")
    snippet = item.get("snippet", {})
    if label == LABEL_SHORTS:
        url = f"https://youtube.com/shorts/{video_id}"
    else:
        url = f"https://www.youtube.com/watch?v={video_id}"
    return {
        "title": snippet.get("title", ""),
        "url": url,
        "channel": snippet.get("channelTitle", ""),
        "type": label,
    }


def _notify(db: Client, item: dict, decision: Decision, now: datetime) -> str:
    video_id = item["id"]
    channel_id = item.get("snippet", {}).get("channelId", "")
    config = get_config(db, channel_id)
    kind_config = config[decision.kind]

    if not kind_config["enabled"] or not kind_config["discord_channel_id"]:
        logging.info(f"🔕 {channel_id} 未開啟 {decision.kind} 通知，略過 {video_id}")
        return RESULT_DISABLED

    # 先佔位再發送：create() 在文件已存在時會失敗，避免重複推播造成重複通知
    sent_ref = db.collection(SENT_COLLECTION).document(video_id)
    try:
        sent_ref.create(
            {
                "channelId": channel_id,
                "kind": decision.kind,
                "label": decision.label,
                "createdAt": now,
            }
        )
    except AlreadyExists:
        logging.info(f"♻️ {video_id} 已通知過，略過")
        return RESULT_DUPLICATE

    content, allowed_mentions = render_message(
        kind_config, config["guild_id"], build_context(item, decision.label or "")
    )
    try:
        message_id = send_message(kind_config["discord_channel_id"], content, allowed_mentions)
    except AppError as e:
        logging.error(f"🔥 Discord 通知發送失敗：{video_id} / {e.log_message or e.message}")
        sent_ref.delete()
        return RESULT_FAILED

    sent_ref.update({"messageId": message_id, "sentAt": now})
    logging.info(f"📣 已發送 {decision.kind} 通知：{video_id} → message {message_id}")
    return RESULT_SENT


def _record_failure(db: Client, video_id: str, sources: dict) -> None:
    for collection, attempts in sources.items():
        ref = db.collection(collection).document(video_id)
        if attempts + 1 >= MAX_ATTEMPTS:
            logging.error(f"❌ {video_id} 發送失敗達 {MAX_ATTEMPTS} 次，放棄")
            ref.delete()
        else:
            ref.update({"attempts": attempts + 1})


def _clear(db: Client, video_id: str, sources: dict) -> None:
    for collection in sources:
        db.collection(collection).document(video_id).delete()


def run_tick(db: Client, now: datetime) -> dict:
    # video_id → {collection: attempts}，記錄這支影片來自佇列還是待機室
    targets: dict[str, dict[str, int]] = {}

    for doc in db.collection(QUEUE_COLLECTION).stream():
        targets.setdefault(doc.id, {})[QUEUE_COLLECTION] = (doc.to_dict() or {}).get("attempts", 0)

    due_pending = (
        db.collection(PENDING_COLLECTION).where("scheduledStart", "<=", now + PENDING_LEAD).stream()
    )
    for doc in due_pending:
        targets.setdefault(doc.id, {})[PENDING_COLLECTION] = (doc.to_dict() or {}).get(
            "attempts", 0
        )

    stats = {"checked": len(targets), RESULT_SENT: 0, "waiting": 0, "skipped": 0}
    if not targets:
        return stats

    items = batch_fetch_video_details(list(targets.keys()), parts=FETCH_PARTS)
    if not items:
        # 批次查詢失敗時 batch_fetch_video_details 會回傳空列表，保留所有項目下次再查
        logging.warning(f"⚠️ YouTube 查詢沒有結果，保留 {len(targets)} 支影片下次再試")
        stats["skipped"] = len(targets)
        return stats

    item_map = {item["id"]: item for item in items}

    for video_id, sources in targets.items():
        item = item_map.get(video_id)
        if not item:
            # 影片被刪除或設為私人
            logging.info(f"🗑️ 查無影片，移除：{video_id}")
            _clear(db, video_id, sources)
            stats["skipped"] += 1
            continue

        decision = classify_for_notify(item, now)

        if decision.action == ACTION_NOTIFY:
            result = _notify(db, item, decision, now)
            if result == RESULT_FAILED:
                _record_failure(db, video_id, sources)
            else:
                _clear(db, video_id, sources)
                if result == RESULT_SENT:
                    stats[RESULT_SENT] += 1
            continue

        if decision.action == ACTION_WAIT:
            scheduled = datetime.fromisoformat(
                (decision.scheduled_start or "").replace("Z", "+00:00")
            )
            if now - scheduled > PENDING_EXPIRE:
                logging.info(f"⏰ 待機室逾時未開台，移除：{video_id}")
                _clear(db, video_id, sources)
                stats["skipped"] += 1
                continue
            db.collection(PENDING_COLLECTION).document(video_id).set(
                {
                    "channelId": item.get("snippet", {}).get("channelId", ""),
                    "scheduledStart": scheduled,
                    "updatedAt": now,
                },
                merge=True,
            )
            db.collection(QUEUE_COLLECTION).document(video_id).delete()
            stats["waiting"] += 1
            continue

        logging.info(f"⏭️ 不通知 {video_id}：{decision.reason}")
        _clear(db, video_id, sources)
        stats["skipped"] += 1

    logging.info(f"✅ Discord 通知 tick 完成：{stats}")
    return stats


TEST_NOTICE = {
    KIND_LIVE: "🔧 **這是測試訊息**，用來確認通知設定，並沒有真的開台。以下是通知的範例：",
    KIND_VIDEO: "🔧 **這是測試訊息**，用來確認通知設定，並沒有發布新影片。以下是通知的範例：",
}
TEST_TITLE = "（範例標題）"


def send_test_message(db: Client, channel_id: str, kind: str) -> str:
    """用範例內容發一則測試訊息，回傳 message id"""
    config = get_config(db, channel_id)
    kind_config = config[kind]
    if not kind_config["discord_channel_id"]:
        raise AppError("請先選擇要發送的 Discord 頻道", status_code=400)

    channel_doc = db.collection("channel_index").document(channel_id).get()
    channel_name = (channel_doc.to_dict() or {}).get("name", "")  # type: ignore[union-attr]
    context = {
        "title": TEST_TITLE,
        "url": f"https://www.youtube.com/channel/{channel_id}",
        "channel": channel_name,
        "type": LABEL_LIVE if kind == KIND_LIVE else LABEL_VIDEO,
    }
    content, _ = render_message(kind_config, config["guild_id"], context)
    # 開頭標明是測試，避免成員誤以為真的開台或上片。tag 只顯示文字，不實際提醒
    return send_message(
        kind_config["discord_channel_id"], f"{TEST_NOTICE[kind]}\n{content}", {"parse": []}
    )
