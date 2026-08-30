"""爬蟲設定:環境變數讀取與預設值。

注意:此模組刻意不叫 config.py,根目錄 .gitignore 有全域的 config.py 排除規則。
"""

import os
from pathlib import Path

# backend/.env.local(不進版控)存放 SUPABASE_DB_URL
_ENV_LOCAL = Path(__file__).resolve().parents[1] / ".env.local"

# 目標 schema:staging(開發/測試)或 public(production)
DB_SCHEMA = os.getenv("CRAWLER_DB_SCHEMA", "staging")

# 每個頻道回溯的直播 VOD 數
BACKFILL_VIDEOS_PER_CHANNEL = int(os.getenv("CRAWLER_BACKFILL_VIDEOS", "10"))

# 列表階段的掃描倍率:會員限定與進行中的直播會被濾掉,多掃幾部才補得滿回溯額度
LIST_SCAN_MULTIPLIER = int(os.getenv("CRAWLER_LIST_SCAN_MULTIPLIER", "3"))

# 擴張深度上限:crawl_depth <= 此值的合格頻道才會被排入 list_videos
# -1 = 不設限,改由佇列優先權(連結度優先)與 run --max-tasks 的預算控制擴張範圍
MAX_CRAWL_DEPTH = int(os.getenv("CRAWLER_MAX_DEPTH", "-1"))

# 訂閱數低於此值的頻道不排入爬取(network_edges view 也會濾掉,爬了畫不出來)
MIN_SUBSCRIBERS = int(os.getenv("CRAWLER_MIN_SUBSCRIBERS", "100"))

# 每個任務之間的等待秒數(加上隨機抖動),避免請求過密
TASK_SLEEP_SECONDS = float(os.getenv("CRAWLER_TASK_SLEEP", "6"))

# 已知聊天機器人帳號名稱(比對時轉小寫)
KNOWN_BOT_NAMES = {
    "nightbot",
    "@nightbot",
    "streamlabs",
    "@streamlabs",
    "streamelements",
    "@streamelements",
    "fossabot",
    "@fossabot",
}


def _read_setting(name: str) -> str | None:
    """讀取設定值:優先環境變數,其次 backend/.env.local。"""
    value = os.getenv(name)
    if value:
        return value

    if _ENV_LOCAL.exists():
        for line in _ENV_LOCAL.read_text(encoding="utf-8-sig").splitlines():
            line = line.strip()
            if line.startswith(f"{name}="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def get_db_url() -> str:
    """取得 Supabase 連線字串。"""
    url = _read_setting("SUPABASE_DB_URL")
    if not url:
        raise RuntimeError("找不到 SUPABASE_DB_URL(環境變數或 backend/.env.local)")
    return url


def get_youtube_api_key() -> str:
    """取得 YouTube Data API key(enrich-channels 用)。"""
    key = _read_setting("YOUTUBE_API_KEY") or _read_setting("API_KEY")
    if not key:
        raise RuntimeError("找不到 YOUTUBE_API_KEY(環境變數或 backend/.env.local)")
    return key
