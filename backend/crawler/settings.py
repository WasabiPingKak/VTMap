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

# 擴張深度上限:crawl_depth <= 此值的合格頻道才會被排入 list_videos
# (種子 = 0,種子的管理員 = 1;預設爬到 1,節點最遠長到 2)
MAX_CRAWL_DEPTH = int(os.getenv("CRAWLER_MAX_DEPTH", "1"))

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


def get_db_url() -> str:
    """取得 Supabase 連線字串:優先讀環境變數,其次讀 backend/.env.local。"""
    url = os.getenv("SUPABASE_DB_URL")
    if url:
        return url

    if _ENV_LOCAL.exists():
        for line in _ENV_LOCAL.read_text(encoding="utf-8-sig").splitlines():
            line = line.strip()
            if line.startswith("SUPABASE_DB_URL="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")

    raise RuntimeError("找不到 SUPABASE_DB_URL(環境變數或 backend/.env.local)")
