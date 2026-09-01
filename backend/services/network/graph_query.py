"""關係網路圖的 SQL 與資料組裝。

此模組保持與 Python 3.10 相容(crawler 的本機 dev server 也會 import),
且不依賴 Flask,純函式可直接單元測試。
"""

from datetime import datetime
from typing import Any

# 出現在任一條邊上的頻道(圖的節點)。
# scanned = 這個頻道曾被當成 host 掃過至少一次(有人在他的直播裡被記錄過);
# 用來讓前端可以標出「等待掃描」節點,避免熟人看到連線數少誤以為圖漏了東西。
NODES_SQL = """
select c.channel_id, c.title, c.handle, c.thumbnail_url, c.in_vtmap,
       c.subscriber_count,
       exists (
         select 1 from chat_badge_observations o
         where o.host_channel_id = c.channel_id
       ) as scanned
from channels c
where c.channel_id in (
  select channel_a from network_edges
  union
  select channel_b from network_edges
)
"""

EDGES_SQL = """
select channel_a, channel_b, evidence_count, last_seen_video_at
from network_edges
"""

# 管理員觀察(證據);host 一定在圖上,配對過濾在 Python 端做
EVIDENCE_SQL = """
select least(author_channel_id, host_channel_id),
       greatest(author_channel_id, host_channel_id),
       video_id, video_title, video_published_at, author_channel_id
from chat_badge_observations
where badge_type = 'moderator'
order by video_published_at desc nulls last
"""

# 節點在爬蟲佇列的累計順位:
# stage 1 check_qualification → stage 2 list_videos → stage 3 fetch_chat。
# 找出該頻道最早階段的 pending task,rank = 該階段內名次 + 更早階段的 pending 總數。
# 沒有任何 pending task 時 my_task 空,整個查詢回空(rank=null,前端顯示「尚未在掃描隊列中」)。
# stage 2 依 priority desc(reprioritize 過)、其餘依 id asc(FIFO)。
QUEUE_RANK_SQL = """
with stages as (
  select
    (select count(*) from crawl_queue where status = 'pending' and kind = 'check_qualification') as cq_total,
    (select count(*) from crawl_queue where status = 'pending' and kind = 'list_videos') as lv_total
),
my_task as (
  select kind, priority, id
  from crawl_queue
  where channel_id = %s and status = 'pending'
  order by
    case kind
      when 'check_qualification' then 1
      when 'list_videos' then 2
      when 'fetch_chat' then 3
    end,
    id asc
  limit 1
)
select
  case mt.kind
    when 'check_qualification' then
      (select count(*) from crawl_queue
       where status = 'pending' and kind = 'check_qualification' and id <= mt.id)
    when 'list_videos' then
      s.cq_total + (select count(*) from crawl_queue
                    where status = 'pending' and kind = 'list_videos'
                      and (priority > mt.priority
                           or (priority = mt.priority and id <= mt.id)))
    when 'fetch_chat' then
      s.cq_total + s.lv_total + (select count(*) from crawl_queue
                                 where status = 'pending' and kind = 'fetch_chat' and id <= mt.id)
  end as rank
from stages s, my_task mt
"""

# 最近加入的頻道(側邊「最新加入」面板用)。
# 只取有出現在圖上的頻道(避免顯示 0 條線的孤點讓使用者感到訝異),
# 依 created_at 降冪,limit 由呼叫端傳入(避免 SQL 注入,靠參數)。
RECENT_SQL = """
select c.channel_id, c.title, c.handle, c.thumbnail_url,
       c.subscriber_count, c.created_at,
       exists (
         select 1 from chat_badge_observations o
         where o.host_channel_id = c.channel_id
       ) as scanned
from channels c
where c.channel_id in (
  select channel_a from network_edges
  union
  select channel_b from network_edges
)
order by c.created_at desc
limit %s
"""


def _iso(value: Any) -> str | None:
    return value.isoformat() if isinstance(value, datetime) else None


def build_graph_payload(
    node_rows: list[tuple],
    edge_rows: list[tuple],
    evidence_rows: list[tuple],
) -> dict:
    """把三段查詢結果組裝成 API 回應。"""
    edges: dict[tuple[str, str], dict] = {}
    for channel_a, channel_b, evidence_count, last_seen in edge_rows:
        edges[(channel_a, channel_b)] = {
            "a": channel_a,
            "b": channel_b,
            "evidence_count": int(evidence_count),
            "last_seen_video_at": _iso(last_seen),
            "evidence": [],
        }

    for pair_a, pair_b, video_id, video_title, published_at, author_id in evidence_rows:
        edge = edges.get((pair_a, pair_b))
        if edge is None:
            continue  # 未通過准入的觀察不屬於任何邊
        edge["evidence"].append(
            {
                "video_id": video_id,
                "video_title": video_title,
                "video_published_at": _iso(published_at),
                "moderator_channel_id": author_id,
            }
        )

    nodes = [
        {
            "channel_id": channel_id,
            "title": title,
            "handle": handle,
            "thumbnail": thumbnail_url,
            "in_vtmap": bool(in_vtmap),
            "subscriber_count": int(subscriber_count) if subscriber_count is not None else None,
            "scanned": bool(scanned),
        }
        for channel_id, title, handle, thumbnail_url, in_vtmap, subscriber_count, scanned in node_rows
    ]

    return {"nodes": nodes, "edges": list(edges.values())}


def fetch_graph_payload(conn: Any) -> dict:
    """用已設好 search_path 的連線抓出完整圖。conn 為 psycopg Connection。"""
    with conn.cursor() as cur:
        cur.execute(NODES_SQL)
        node_rows = cur.fetchall()
        cur.execute(EDGES_SQL)
        edge_rows = cur.fetchall()
        cur.execute(EVIDENCE_SQL)
        evidence_rows = cur.fetchall()
    return build_graph_payload(node_rows, edge_rows, evidence_rows)


def build_recent_payload(rows: list[tuple]) -> dict:
    """把 RECENT_SQL 結果組成 API 回應。created_at 用 ISO 傳,前端算相對時間。"""
    return {
        "nodes": [
            {
                "channel_id": channel_id,
                "title": title,
                "handle": handle,
                "thumbnail": thumbnail_url,
                "subscriber_count": int(subscriber_count) if subscriber_count is not None else None,
                "created_at": _iso(created_at),
                "scanned": bool(scanned),
            }
            for channel_id, title, handle, thumbnail_url, subscriber_count, created_at, scanned in rows
        ],
    }


def fetch_recent_payload(conn: Any, limit: int) -> dict:
    """抓最近加入的頻道(依 created_at 降冪),限制到 on-graph 節點。"""
    with conn.cursor() as cur:
        cur.execute(RECENT_SQL, (limit,))
        rows = cur.fetchall()
    return build_recent_payload(rows)


def fetch_queue_rank(conn: Any, channel_id: str) -> int | None:
    """回傳該頻道在爬蟲佇列的累計順位;沒有 pending task 時回 None。"""
    with conn.cursor() as cur:
        cur.execute(QUEUE_RANK_SQL, (channel_id,))
        row = cur.fetchone()
    if row is None or row[0] is None:
        return None
    return int(row[0])
