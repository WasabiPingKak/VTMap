"""crawl 相關資料表的存取操作。"""

from dataclasses import dataclass
from datetime import datetime

import psycopg

KIND_LIST_VIDEOS = "list_videos"
KIND_FETCH_CHAT = "fetch_chat"
KIND_CHECK_QUALIFICATION = "check_qualification"

MAX_ATTEMPTS = 3


@dataclass
class Task:
    id: int
    kind: str
    channel_id: str | None
    video_id: str | None
    attempts: int


def upsert_channel(
    conn: psycopg.Connection,
    channel_id: str,
    *,
    title: str | None = None,
    handle: str | None = None,
    thumbnail_url: str | None = None,
    source: str = "discovered",
    in_vtmap: bool | None = None,
    is_bot: bool | None = None,
    has_stream_history: bool | None = None,
    crawl_depth: int | None = None,
) -> None:
    """新增或更新頻道。已存在時只補上有提供的欄位,crawl_depth 取較小值(離種子較近)。"""
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into channels
              (channel_id, title, handle, thumbnail_url, source, in_vtmap, is_bot,
               has_stream_history, crawl_depth)
            values (%s, %s, %s, %s, %s, coalesce(%s, false), coalesce(%s, false),
                    %s, coalesce(%s, 0))
            on conflict (channel_id) do update set
              title = coalesce(excluded.title, channels.title),
              handle = coalesce(excluded.handle, channels.handle),
              thumbnail_url = coalesce(excluded.thumbnail_url, channels.thumbnail_url),
              source = case when excluded.source = 'seed' then 'seed' else channels.source end,
              in_vtmap = channels.in_vtmap or excluded.in_vtmap,
              is_bot = channels.is_bot or excluded.is_bot,
              has_stream_history = coalesce(excluded.has_stream_history,
                                            channels.has_stream_history),
              crawl_depth = least(channels.crawl_depth, excluded.crawl_depth)
            """,
            (
                channel_id,
                title,
                handle,
                thumbnail_url,
                source,
                in_vtmap,
                is_bot,
                has_stream_history,
                crawl_depth,
            ),
        )


def get_channel_depth(conn: psycopg.Connection, channel_id: str) -> int:
    with conn.cursor() as cur:
        cur.execute("select crawl_depth from channels where channel_id = %s", (channel_id,))
        row = cur.fetchone()
    return int(row[0]) if row else 0


def set_qualification(conn: psycopg.Connection, channel_id: str, has_history: bool) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            update channels
            set has_stream_history = %s, qualification_checked_at = now()
            where channel_id = %s
            """,
            (has_history, channel_id),
        )


def enqueue(
    conn: psycopg.Connection,
    kind: str,
    *,
    channel_id: str | None = None,
    video_id: str | None = None,
    priority: int = 0,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into crawl_queue (kind, channel_id, video_id, priority)
            values (%s, %s, %s, %s)
            on conflict do nothing
            """,
            (kind, channel_id, video_id, priority),
        )


def enqueue_missing_list_videos(conn: psycopg.Connection, min_subscribers: int) -> int:
    """為所有合格但從未排過 list_videos 的頻道排入任務,回傳新增筆數。

    check_qualification 的去重是永久的,所以放寬深度上限後,先前被擋下的頻道
    不會自己重排。這個操作補上那些缺口(訂閱數未知的頻道先放行,等 enrich 補完)。
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into crawl_queue (kind, channel_id)
            select %s, c.channel_id
            from channels c
            where c.has_stream_history
              and not c.is_bot
              and (c.subscriber_count is null or c.subscriber_count >= %s)
              and not exists (
                select 1 from crawl_queue q
                where q.kind = %s and q.channel_id = c.channel_id
              )
            on conflict do nothing
            """,
            (KIND_LIST_VIDEOS, min_subscribers, KIND_LIST_VIDEOS),
        )
        return cur.rowcount


def reprioritize_pending_list_videos(conn: psycopg.Connection) -> int:
    """重算待處理 list_videos 的優先權:連結度優先,同連結度比訂閱數。

    優先權 = 連結度 × 1000 + 訂閱數級距(log10 × 100,上限 999),
    所以連結度永遠壓過訂閱數。連結度與訂閱數都會隨爬取變動,每批開跑前重算一次。
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            with deg as (
              select c, count(*) as degree from (
                select channel_a as c from network_edges
                union all
                select channel_b from network_edges
              ) t group by c
            )
            update crawl_queue q
            set priority = coalesce(d.degree, 0) * 1000
                         + least(
                             999,
                             floor(log(greatest(coalesce(ch.subscriber_count, 1), 1)) * 100)::int
                           )
            from channels ch
            left join deg d on d.c = ch.channel_id
            where q.kind = %s
              and q.status = 'pending'
              and q.channel_id = ch.channel_id
            """,
            (KIND_LIST_VIDEOS,),
        )
        return cur.rowcount


def reclaim_stale_running(conn: psycopg.Connection, older_than_minutes: int) -> int:
    """把卡在 running 太久的任務放回 pending,回傳筆數。

    程序中途被砍或連線斷掉時,已認領的任務會永遠停在 running(claim 只挑 pending),
    長時間執行必須定期回收,否則這些任務就此消失。
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            update crawl_queue
            set status = 'pending'
            where status = 'running'
              and updated_at < now() - make_interval(mins => %s)
            """,
            (older_than_minutes,),
        )
        return cur.rowcount


def claim_next_task(conn: psycopg.Connection, kinds: list[str]) -> Task | None:
    """取出一筆待處理任務並標記為 running(FOR UPDATE SKIP LOCKED 防重複認領)。"""
    with conn.cursor() as cur:
        cur.execute(
            """
            update crawl_queue
            set status = 'running', attempts = attempts + 1
            where id = (
              select id from crawl_queue
              where status = 'pending' and kind = any(%s)
              order by priority desc, id
              limit 1
              for update skip locked
            )
            returning id, kind, channel_id, video_id, attempts
            """,
            (kinds,),
        )
        row = cur.fetchone()
    if row is None:
        return None
    return Task(id=row[0], kind=row[1], channel_id=row[2], video_id=row[3], attempts=row[4])


def mark_task_done(conn: psycopg.Connection, task_id: int) -> None:
    with conn.cursor() as cur:
        cur.execute("update crawl_queue set status = 'done' where id = %s", (task_id,))


def mark_task_failed(conn: psycopg.Connection, task: Task, error: str) -> None:
    """記錄錯誤;未達重試上限時放回 pending。"""
    status = "failed" if task.attempts >= MAX_ATTEMPTS else "pending"
    with conn.cursor() as cur:
        cur.execute(
            "update crawl_queue set status = %s, last_error = %s where id = %s",
            (status, error[:2000], task.id),
        )


def insert_observation(
    conn: psycopg.Connection,
    *,
    video_id: str,
    host_channel_id: str,
    author_channel_id: str,
    badge_type: str,
    message_count: int,
    video_published_at: datetime | None,
    video_title: str | None = None,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into chat_badge_observations
              (video_id, host_channel_id, author_channel_id, badge_type,
               message_count, video_published_at, video_title)
            values (%s, %s, %s, %s, %s, %s, %s)
            on conflict (video_id, author_channel_id, badge_type) do update set
              message_count = excluded.message_count,
              video_published_at = coalesce(excluded.video_published_at,
                                            chat_badge_observations.video_published_at),
              video_title = coalesce(excluded.video_title,
                                     chat_badge_observations.video_title)
            """,
            (
                video_id,
                host_channel_id,
                author_channel_id,
                badge_type,
                message_count,
                video_published_at,
                video_title,
            ),
        )


def insert_crawl_log(
    conn: psycopg.Connection,
    *,
    video_id: str,
    host_channel_id: str | None,
    status: str,
    message_lines: int | None = None,
    distinct_authors: int | None = None,
    moderator_count: int | None = None,
    error: str | None = None,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            insert into crawl_log
              (video_id, host_channel_id, status, message_lines, distinct_authors,
               moderator_count, error)
            values (%s, %s, %s, %s, %s, %s, %s)
            """,
            (
                video_id,
                host_channel_id,
                status,
                message_lines,
                distinct_authors,
                moderator_count,
                error[:2000] if error else None,
            ),
        )


def queue_summary(conn: psycopg.Connection) -> list[tuple[str, str, int]]:
    with conn.cursor() as cur:
        cur.execute(
            "select kind, status, count(*) from crawl_queue group by kind, status order by 1, 2"
        )
        return [(r[0], r[1], int(r[2])) for r in cur.fetchall()]


def retry_failed_tasks(conn: psycopg.Connection) -> int:
    """把所有 failed 任務放回 pending 並重置 attempts。"""
    with conn.cursor() as cur:
        cur.execute(
            "update crawl_queue set status = 'pending', attempts = 0 where status = 'failed'"
        )
        return cur.rowcount


def requeue_list_videos_for_channel(conn: psycopg.Connection, channel_id: str) -> int:
    """把指定頻道的 list_videos 從 done/failed 改回 pending。"""
    with conn.cursor() as cur:
        cur.execute(
            """
            update crawl_queue
            set status = 'pending', attempts = 0
            where kind = %s and channel_id = %s and status in ('done', 'failed')
            """,
            (KIND_LIST_VIDEOS, channel_id),
        )
        return cur.rowcount


def data_summary(conn: psycopg.Connection) -> dict[str, int]:
    with conn.cursor() as cur:
        cur.execute("select count(*) from channels")
        channels = int(cur.fetchone()[0])  # type: ignore[index]
        cur.execute("select count(*) from chat_badge_observations")
        observations = int(cur.fetchone()[0])  # type: ignore[index]
        cur.execute("select count(*) from network_edges")
        edges = int(cur.fetchone()[0])  # type: ignore[index]
    return {"channels": channels, "observations": observations, "edges": edges}
