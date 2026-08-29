"""爬蟲管線:種子載入與三種任務的處理邏輯。

任務流程:
  seed(VTMap 收錄頻道) → list_videos → fetch_chat → 發現新頻道
    → check_qualification →(合格且深度允許)→ list_videos ...
"""

import logging
import random
import tempfile
import time
from pathlib import Path

import psycopg
import requests

from crawler import chat_parser, repo, ytdlp
from crawler.settings import (
    BACKFILL_VIDEOS_PER_CHANNEL,
    KNOWN_BOT_NAMES,
    MAX_CRAWL_DEPTH,
    TASK_SLEEP_SECONDS,
)

logger = logging.getLogger(__name__)


def seed_from_api(conn: psycopg.Connection, api_base: str, limit: int | None = None) -> int:
    """從 VTMap /api/channels/index 載入種子頻道並排入 list_videos。"""
    resp = requests.get(f"{api_base.rstrip('/')}/api/channels/index", timeout=30)
    resp.raise_for_status()
    channels = resp.json().get("channels", [])
    if limit:
        channels = channels[:limit]

    count = 0
    for entry in channels:
        channel_id = entry.get("channel_id")
        if not channel_id:
            continue
        repo.upsert_channel(
            conn,
            channel_id,
            title=entry.get("name"),
            thumbnail_url=entry.get("thumbnail"),
            source="seed",
            in_vtmap=True,
            # 種子是站上收錄的 VTuber,直接視為通過准入
            has_stream_history=True,
            crawl_depth=0,
        )
        repo.enqueue(conn, repo.KIND_LIST_VIDEOS, channel_id=channel_id)
        count += 1
    conn.commit()
    return count


def add_manual_seed(conn: psycopg.Connection, channel_id: str) -> None:
    """手動加入單一種子頻道(冒煙測試或補漏用)。"""
    repo.upsert_channel(
        conn,
        channel_id,
        source="seed",
        has_stream_history=True,
        crawl_depth=0,
    )
    repo.enqueue(conn, repo.KIND_LIST_VIDEOS, channel_id=channel_id)
    conn.commit()


def process_list_videos(conn: psycopg.Connection, task: repo.Task) -> None:
    """列出頻道最近的直播 VOD,排入 fetch_chat。"""
    assert task.channel_id is not None
    entries = ytdlp.list_recent_streams(task.channel_id, BACKFILL_VIDEOS_PER_CHANNEL)
    if entries is None:
        # 沒有直播分頁:同時更新准入結果
        repo.set_qualification(conn, task.channel_id, has_history=False)
        return

    for entry in entries:
        if entry.live_status in ("is_live", "is_upcoming"):
            continue  # 進行中或預定直播沒有 replay
        repo.enqueue(
            conn, repo.KIND_FETCH_CHAT, channel_id=task.channel_id, video_id=entry.video_id
        )


def process_fetch_chat(conn: psycopg.Connection, task: repo.Task) -> None:
    """下載並解析單部 VOD 的聊天室 replay,寫入觀察與發現的新頻道。"""
    assert task.channel_id is not None and task.video_id is not None
    host_channel_id = task.channel_id
    host_depth = repo.get_channel_depth(conn, host_channel_id)

    with tempfile.TemporaryDirectory(prefix="vtmap_chat_") as tmp:
        result = ytdlp.download_live_chat(task.video_id, Path(tmp))
        if result.chat_path is None:
            repo.insert_crawl_log(
                conn, video_id=task.video_id, host_channel_id=host_channel_id, status="no_chat"
            )
            return
        stats = chat_parser.parse_live_chat_file(result.chat_path)

    moderators = stats.authors_with_badge(chat_parser.BADGE_MODERATOR)
    for author_id, author in moderators.items():
        if author_id == host_channel_id:
            continue
        is_bot = author.name.lower() in KNOWN_BOT_NAMES
        repo.upsert_channel(
            conn,
            author_id,
            title=author.name,
            thumbnail_url=author.photo_url,
            source="discovered",
            is_bot=is_bot,
            crawl_depth=host_depth + 1,
        )
        repo.insert_observation(
            conn,
            video_id=task.video_id,
            host_channel_id=host_channel_id,
            author_channel_id=author_id,
            badge_type=chat_parser.BADGE_MODERATOR,
            message_count=author.message_count,
            video_published_at=result.published_at,
            video_title=result.title or None,
        )
        if not is_bot:
            repo.enqueue(conn, repo.KIND_CHECK_QUALIFICATION, channel_id=author_id)

    repo.insert_crawl_log(
        conn,
        video_id=task.video_id,
        host_channel_id=host_channel_id,
        status="ok",
        message_lines=stats.total_lines,
        distinct_authors=len(stats.authors),
        moderator_count=len(moderators),
    )


def process_check_qualification(conn: psycopg.Connection, task: repo.Task) -> None:
    """檢查頻道是否曾經直播;合格且深度允許時排入 list_videos 往外擴張。"""
    assert task.channel_id is not None
    with conn.cursor() as cur:
        cur.execute(
            "select has_stream_history, crawl_depth from channels where channel_id = %s",
            (task.channel_id,),
        )
        row = cur.fetchone()
    if row is None:
        return
    has_history, depth = row

    if has_history is None:
        entries = ytdlp.list_recent_streams(task.channel_id, 1)
        has_history = entries is not None and len(entries) > 0
        repo.set_qualification(conn, task.channel_id, has_history=bool(has_history))

    if has_history and depth <= MAX_CRAWL_DEPTH:
        repo.enqueue(conn, repo.KIND_LIST_VIDEOS, channel_id=task.channel_id)


_PROCESSORS = {
    repo.KIND_LIST_VIDEOS: process_list_videos,
    repo.KIND_FETCH_CHAT: process_fetch_chat,
    repo.KIND_CHECK_QUALIFICATION: process_check_qualification,
}


def run_queue(
    conn: psycopg.Connection,
    kinds: list[str] | None = None,
    max_tasks: int | None = None,
    sleep_seconds: float = TASK_SLEEP_SECONDS,
) -> int:
    """循序消化佇列,回傳處理的任務數。"""
    kinds = kinds or list(_PROCESSORS.keys())
    processed = 0
    while max_tasks is None or processed < max_tasks:
        task = repo.claim_next_task(conn, kinds)
        conn.commit()
        if task is None:
            break

        logger.info(
            "處理任務 #%s %s channel=%s video=%s",
            task.id,
            task.kind,
            task.channel_id,
            task.video_id,
        )
        try:
            _PROCESSORS[task.kind](conn, task)
            repo.mark_task_done(conn, task.id)
            conn.commit()
        except Exception as e:
            conn.rollback()
            logger.warning("任務 #%s 失敗:%s", task.id, e)
            repo.mark_task_failed(conn, task, str(e))
            conn.commit()

        processed += 1
        if sleep_seconds > 0:
            time.sleep(sleep_seconds + random.uniform(0, sleep_seconds * 0.5))
    return processed
