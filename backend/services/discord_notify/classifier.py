# services/discord_notify/classifier.py
# 判斷一支影片在 Discord 通知流程中該怎麼處理

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta

import isodate
import requests

# 通知種類：直播開台 / 影片（長片、Shorts、首播）
KIND_LIVE = "live"
KIND_VIDEO = "video"
KINDS = (KIND_LIVE, KIND_VIDEO)

# 動作
ACTION_NOTIFY = "notify"  # 立即發送
ACTION_WAIT = "wait"  # 待機室，等開台
ACTION_SKIP = "skip"  # 不處理

# 影片類型（給模板 {type} 用）
LABEL_LIVE = "直播"
LABEL_VIDEO = "影片"
LABEL_SHORTS = "Shorts"
LABEL_PREMIERE = "首播"

# 超過這個時間才收到推播的影片視為舊片（例如改標題觸發的推播），不通知
VIDEO_FRESH_WINDOW = timedelta(hours=24)
LIVE_FRESH_WINDOW = timedelta(hours=2)

# YouTube 2024-10 起 Shorts 上限為 3 分鐘
SHORTS_MAX_SECONDS = 180

# 與 utils/youtube_utils.get_video_type 相同的首播判斷門檻
PREMIERE_PUBLISH_GAP_SECONDS = 300


@dataclass
class Decision:
    action: str
    kind: str | None = None
    label: str | None = None
    scheduled_start: str | None = None
    reason: str = ""


def _parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _duration_seconds(item: dict) -> int:
    raw = item.get("contentDetails", {}).get("duration", "")
    if not raw:
        return 0
    try:
        return int(isodate.parse_duration(raw).total_seconds())
    except Exception:
        return 0


def _is_shorts_url(video_id: str) -> bool | None:
    """
    對 /shorts/{id} 發 HEAD：200 是 Shorts，轉址到 /watch 是一般影片，其他情況回傳 None。

    請求太頻繁時 YouTube 會轉址到 google.com/sorry 的機器人驗證頁，
    那種轉址不代表影片類型，交給呼叫端改用片長判斷。
    """
    try:
        resp = requests.head(
            f"https://www.youtube.com/shorts/{video_id}", allow_redirects=False, timeout=5
        )
    except requests.RequestException as e:
        logging.warning(f"⚠️ Shorts 判斷請求失敗：{video_id} / {e}")
        return None
    if resp.status_code == 200:
        return True
    if 300 <= resp.status_code < 400 and "/watch" in resp.headers.get("Location", ""):
        return False
    logging.warning(
        f"⚠️ Shorts 判斷無法確定：{video_id} / {resp.status_code} "
        f"{resp.headers.get('Location', '')[:80]}"
    )
    return None


def _video_label(item: dict) -> str:
    seconds = _duration_seconds(item)
    if seconds == 0 or seconds > SHORTS_MAX_SECONDS:
        return LABEL_VIDEO
    is_shorts = _is_shorts_url(item.get("id", ""))
    # 判斷失敗時以片長為準
    return LABEL_SHORTS if is_shorts is not False else LABEL_VIDEO


def classify_for_notify(item: dict, now: datetime) -> Decision:
    """
    依 YouTube videos.list 的結果決定通知動作。

    - 一般上傳 → 影片通知（長片 / Shorts）
    - 待機室（直播或首播）→ 等待開台
    - 直播或首播開始 → 直播通知
    - 已結束的首播（推播晚到、開始時沒通知到）→ 影片通知
    - 已結束的直播、私人影片、舊片 → 不處理

    首播開始時一律走直播通知：首播也有聊天室，對觀眾來說跟開台一樣是「現在進來一起看」。
    而且待機室與進行中的階段，API 沒有欄位能區分首播與直播（2026-10 實測首播待機室片長也是 P0D）。
    """
    snippet = item.get("snippet", {})
    status = item.get("status", {})
    live_details = item.get("liveStreamingDetails")

    if status.get("privacyStatus") != "public":
        return Decision(ACTION_SKIP, reason=f"非公開影片（{status.get('privacyStatus')}）")

    if not live_details:
        published = _parse_time(snippet.get("publishedAt"))
        if not published or now - published > VIDEO_FRESH_WINDOW:
            return Decision(ACTION_SKIP, reason="發布時間過久，視為舊片")
        return Decision(ACTION_NOTIFY, KIND_VIDEO, _video_label(item))

    actual_start = _parse_time(live_details.get("actualStartTime"))
    actual_end = live_details.get("actualEndTime")

    if actual_end:
        # 結束後直播檔也有片長，改用與 get_video_type 相同的規則：
        # 首播的 publishedAt 與 actualStartTime 幾乎相同，直播檔的 publishedAt 是待機室建立時間
        published = _parse_time(snippet.get("publishedAt"))
        ended_premiere = (
            actual_start is not None
            and published is not None
            and abs((actual_start - published).total_seconds()) < PREMIERE_PUBLISH_GAP_SECONDS
        )
        # 已結束的首播仍算新影片（例如推播晚到），直播檔則不通知
        if ended_premiere and now - actual_start <= VIDEO_FRESH_WINDOW:  # type: ignore[operator]
            return Decision(ACTION_NOTIFY, KIND_VIDEO, LABEL_PREMIERE)
        return Decision(ACTION_SKIP, reason="已結束的直播")

    if actual_start:
        if now - actual_start > LIVE_FRESH_WINDOW:
            return Decision(ACTION_SKIP, reason="開台已久，視為舊通知")
        # 首播進行中若片長已不為 0，模板的 {type} 顯示「首播」，否則一律視為直播
        label = LABEL_PREMIERE if _duration_seconds(item) > 0 else LABEL_LIVE
        return Decision(ACTION_NOTIFY, KIND_LIVE, label)

    scheduled = live_details.get("scheduledStartTime")
    if scheduled:
        return Decision(ACTION_WAIT, scheduled_start=scheduled)

    return Decision(ACTION_SKIP, reason="無法判斷的直播狀態")
