"""爬取佇列的查詢與新頻道入列(Flask 端)。"""

import logging
from datetime import datetime
from typing import Any

import psycopg

from services.network.supabase import get_connection
from utils.exceptions import ExternalServiceError

logger = logging.getLogger(__name__)

# 新註冊頻道的插隊優先權
REGISTRATION_PRIORITY = 100

# 未完成任務(pending/running/failed)含頻道資訊
_ACTIVE_TASKS_SQL = """
select q.id, q.kind, q.status, q.priority, q.attempts, q.channel_id, q.video_id,
       q.last_error, q.created_at, q.updated_at,
       c.title, c.handle, c.thumbnail_url
from crawl_queue q
left join channels c on c.channel_id = q.channel_id
where q.status in ('pending', 'running', 'failed')
order by case q.status when 'running' then 0 when 'pending' then 1 else 2 end,
         q.priority desc, q.id
limit 500
"""

_SUMMARY_SQL = """
select kind, status, count(*) from crawl_queue group by kind, status order by 1, 2
"""

_RECENT_DONE_SQL = """
select q.id, q.kind, q.channel_id, q.video_id, q.updated_at, c.title, c.handle
from crawl_queue q
left join channels c on c.channel_id = q.channel_id
where q.status = 'done'
order by q.updated_at desc
limit 20
"""


def _iso(value: Any) -> str | None:
    return value.isoformat() if isinstance(value, datetime) else None


def get_queue_detail() -> dict:
    """回傳佇列明細:未完成任務、各狀態統計、最近完成的任務。"""
    try:
        with get_connection() as conn, conn.cursor() as cur:
            cur.execute(_ACTIVE_TASKS_SQL)
            tasks = [
                {
                    "id": row[0],
                    "kind": row[1],
                    "status": row[2],
                    "priority": row[3],
                    "attempts": row[4],
                    "channel_id": row[5],
                    "video_id": row[6],
                    "last_error": row[7],
                    "created_at": _iso(row[8]),
                    "updated_at": _iso(row[9]),
                    "channel_title": row[10],
                    "channel_handle": row[11],
                    "channel_thumbnail": row[12],
                }
                for row in cur.fetchall()
            ]
            cur.execute(_SUMMARY_SQL)
            summary = [
                {"kind": row[0], "status": row[1], "count": int(row[2])} for row in cur.fetchall()
            ]
            cur.execute(_RECENT_DONE_SQL)
            recent_done = [
                {
                    "id": row[0],
                    "kind": row[1],
                    "channel_id": row[2],
                    "video_id": row[3],
                    "updated_at": _iso(row[4]),
                    "channel_title": row[5],
                    "channel_handle": row[6],
                }
                for row in cur.fetchall()
            ]
        return {"tasks": tasks, "summary": summary, "recent_done": recent_done}
    except psycopg.Error as e:
        logger.error("佇列查詢失敗:%s", e)
        raise ExternalServiceError(
            "佇列資料暫時無法取得",
            log_message=f"Supabase 查詢失敗:{e}",
        ) from e


def enqueue_registered_channel(channel_id: str) -> None:
    """新註冊頻道立即入列(高優先權)。

    失敗時拋出例外,由呼叫端決定是否吞掉(註冊流程不應因此中斷)。
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                insert into channels
                  (channel_id, source, in_vtmap, has_stream_history, crawl_depth)
                values (%s, 'seed', true, true, 0)
                on conflict (channel_id) do update set
                  source = 'seed',
                  in_vtmap = true,
                  has_stream_history = coalesce(channels.has_stream_history, true)
                """,
                (channel_id,),
            )
            cur.execute(
                """
                insert into crawl_queue (kind, channel_id, priority)
                values ('list_videos', %s, %s)
                on conflict do nothing
                """,
                (channel_id, REGISTRATION_PRIORITY),
            )
        conn.commit()
    logger.info("✅ 新註冊頻道已排入爬取佇列:%s", channel_id)
