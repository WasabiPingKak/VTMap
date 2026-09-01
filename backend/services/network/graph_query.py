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
