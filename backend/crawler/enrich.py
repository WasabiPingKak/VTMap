"""頻道資料補完:用 YouTube Data API channels.list 取得正式名稱、handle 與高解析頭像。

channels.list 一次可查 50 個頻道、成本 1 unit,數百頻道只需個位數 units,
與聊天室爬蟲的 quota 考量無關。
"""

import logging

import psycopg
import requests

logger = logging.getLogger(__name__)

API_URL = "https://www.googleapis.com/youtube/v3/channels"
BATCH_SIZE = 50


def parse_snippets(items: list[dict]) -> dict[str, dict]:
    """把 channels.list 回應整理成 channel_id → {title, handle, thumbnail}。"""
    result: dict[str, dict] = {}
    for item in items:
        channel_id = item.get("id")
        snippet = item.get("snippet") or {}
        if not channel_id:
            continue
        thumbnails = snippet.get("thumbnails") or {}
        thumbnail = None
        for size in ("medium", "default", "high"):
            url = (thumbnails.get(size) or {}).get("url")
            if url:
                thumbnail = url
                break
        result[channel_id] = {
            "title": snippet.get("title") or None,
            "handle": snippet.get("customUrl") or None,  # 形如 @xxx
            "thumbnail": thumbnail,
        }
    return result


def fetch_channel_snippets(api_key: str, channel_ids: list[str]) -> dict[str, dict]:
    resp = requests.get(
        API_URL,
        params={
            "part": "snippet",
            "id": ",".join(channel_ids),
            "maxResults": BATCH_SIZE,
            "key": api_key,
        },
        timeout=30,
    )
    resp.raise_for_status()
    return parse_snippets(resp.json().get("items", []))


def enrich_channels(
    conn: psycopg.Connection, api_key: str, limit: int | None = None
) -> tuple[int, int]:
    """補完尚未 enrich 的頻道,回傳 (更新數, 查無資料數)。

    查無資料的頻道(已刪除/停權)也標記 enriched_at,避免每次重查。
    """
    with conn.cursor() as cur:
        sql = "select channel_id from channels where enriched_at is null order by created_at"
        if limit:
            sql += f" limit {int(limit)}"
        cur.execute(sql)
        pending = [row[0] for row in cur.fetchall()]

    updated = 0
    missing = 0
    for start in range(0, len(pending), BATCH_SIZE):
        batch = pending[start : start + BATCH_SIZE]
        snippets = fetch_channel_snippets(api_key, batch)
        with conn.cursor() as cur:
            for channel_id in batch:
                info = snippets.get(channel_id)
                if info:
                    cur.execute(
                        """
                        update channels
                        set title = coalesce(%s, title),
                            handle = coalesce(%s, handle),
                            thumbnail_url = coalesce(%s, thumbnail_url),
                            enriched_at = now()
                        where channel_id = %s
                        """,
                        (info["title"], info["handle"], info["thumbnail"], channel_id),
                    )
                    updated += 1
                else:
                    cur.execute(
                        "update channels set enriched_at = now() where channel_id = %s",
                        (channel_id,),
                    )
                    missing += 1
        conn.commit()
        logger.info("enrich 進度:%s / %s", min(start + BATCH_SIZE, len(pending)), len(pending))

    return updated, missing
