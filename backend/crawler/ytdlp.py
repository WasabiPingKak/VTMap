"""yt-dlp subprocess 包裝:列出頻道直播 VOD、下載聊天室 replay。

以 subprocess 呼叫而非 import,隔離 yt-dlp 內部 API 變動的影響。
"""

import json
import logging
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

_YTDLP_BASE = [sys.executable, "-m", "yt_dlp", "--socket-timeout", "30", "--retries", "3"]

# yt-dlp 對「頻道沒有直播分頁」的錯誤訊息
_NO_STREAMS_TAB_MARKERS = ("does not have a streams tab", "this channel does not have a")


@dataclass
class StreamEntry:
    video_id: str
    title: str
    live_status: str  # was_live / is_live / is_upcoming / 空字串(未知)


@dataclass
class ChatDownloadResult:
    chat_path: Path | None  # None = 該影片沒有聊天室 replay
    published_at: datetime | None
    title: str
    skip_status: str | None = None  # 受限制影片等非重試型狀態


def list_recent_streams(channel_id: str, limit: int) -> list[StreamEntry] | None:
    """列出頻道直播分頁最近的影片;頻道沒有直播分頁時回傳 None。"""
    url = f"https://www.youtube.com/channel/{channel_id}/streams"
    cmd = [
        *_YTDLP_BASE,
        "--flat-playlist",
        "--playlist-end",
        str(limit),
        "--print",
        "%(id)s\t%(live_status)s\t%(title)s",
        url,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", timeout=120)
    if proc.returncode != 0:
        stderr_lower = proc.stderr.lower()
        if any(marker in stderr_lower for marker in _NO_STREAMS_TAB_MARKERS):
            return None
        raise RuntimeError(f"yt-dlp 列出直播失敗:{proc.stderr.strip()[-500:]}")

    entries = []
    for line in proc.stdout.splitlines():
        parts = line.split("\t", 2)
        if len(parts) != 3:
            continue
        video_id, live_status, title = parts
        if live_status in ("NA", "none"):
            live_status = ""
        entries.append(StreamEntry(video_id=video_id, live_status=live_status, title=title))
    return entries


_MEMBERS_ONLY_MARKERS = (
    "members-only content",
    "channel's members",
    "join this channel",
)
_AGE_RESTRICTED_MARKERS = ("confirm your age",)
_UNAVAILABLE_MARKERS = (
    "video unavailable",
    "this video is unavailable",
    "private video",
    "this video is private",
)


def classify_download_error(stderr: str) -> str | None:
    """將 yt-dlp 錯誤分類為不需重試的影片狀態。"""
    stderr_lower = stderr.lower()
    if any(marker in stderr_lower for marker in _MEMBERS_ONLY_MARKERS):
        return "members_only"
    if any(marker in stderr_lower for marker in _AGE_RESTRICTED_MARKERS):
        return "age_restricted"
    if any(marker in stderr_lower for marker in _UNAVAILABLE_MARKERS):
        return "video_unavailable"
    return None


def download_live_chat(video_id: str, work_dir: Path) -> ChatDownloadResult:
    """下載影片的聊天室 replay 與 metadata。

    聊天室檔:<work_dir>/<video_id>.live_chat.json(沒有 replay 時不存在)
    metadata:<work_dir>/<video_id>.info.json(取得發布時間)
    """
    url = f"https://www.youtube.com/watch?v={video_id}"
    out_template = str(work_dir / video_id)
    cmd = [
        *_YTDLP_BASE,
        "--skip-download",
        "--write-subs",
        "--sub-langs",
        "live_chat",
        "--write-info-json",
        "--no-clean-info-json",
        "-o",
        out_template,
        url,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", timeout=1800)
    if proc.returncode != 0:
        skip_status = classify_download_error(proc.stderr)
        if skip_status:
            return ChatDownloadResult(
                chat_path=None, published_at=None, title="", skip_status=skip_status
            )
        raise RuntimeError(f"yt-dlp 下載聊天室失敗:{proc.stderr.strip()[-500:]}")

    chat_path: Path | None = work_dir / f"{video_id}.live_chat.json"
    if chat_path is not None and not chat_path.exists():
        chat_path = None

    published_at: datetime | None = None
    title = ""
    info_path = work_dir / f"{video_id}.info.json"
    if info_path.exists():
        try:
            info = json.loads(info_path.read_text(encoding="utf-8"))
            title = info.get("title") or ""
            timestamp = info.get("release_timestamp") or info.get("timestamp")
            if timestamp:
                published_at = datetime.fromtimestamp(timestamp, tz=timezone.utc)
        except (json.JSONDecodeError, OSError, ValueError) as e:
            logger.warning("解析 info.json 失敗(%s):%s", video_id, e)

    return ChatDownloadResult(chat_path=chat_path, published_at=published_at, title=title)
