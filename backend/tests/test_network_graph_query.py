"""services.network.graph_query 的純函式測試(不需資料庫)。"""

from datetime import datetime

from services.network.graph_query import build_graph_payload

# naive datetime 即可,_iso 只做 isoformat,不涉及時區運算
TS = datetime(2026, 8, 28, 12, 0, 0)


def test_build_graph_payload_assembles_nodes_edges_evidence():
    node_rows = [
        ("UC_a", "頻道A", "@ch_a", "https://img/a.jpg", True, 12345, True),
        ("UC_b", None, "@ch_b", None, False, None, False),
    ]
    edge_rows = [("UC_a", "UC_b", 2, TS)]
    evidence_rows = [
        ("UC_a", "UC_b", "vid1", "影片一", TS, "UC_b"),
        ("UC_a", "UC_b", "vid2", None, None, "UC_b"),
    ]

    payload = build_graph_payload(node_rows, edge_rows, evidence_rows)

    assert len(payload["nodes"]) == 2
    assert payload["nodes"][0] == {
        "channel_id": "UC_a",
        "title": "頻道A",
        "handle": "@ch_a",
        "thumbnail": "https://img/a.jpg",
        "in_vtmap": True,
        "subscriber_count": 12345,
        "scanned": True,
    }
    assert payload["nodes"][1]["title"] is None
    assert payload["nodes"][1]["handle"] == "@ch_b"
    # 訂閱數 null 直接傳,前端會顯示「訂閱數還沒整理」;scanned=false 讓前端顯示「等待掃描」
    assert payload["nodes"][1]["subscriber_count"] is None
    assert payload["nodes"][1]["scanned"] is False

    assert len(payload["edges"]) == 1
    edge = payload["edges"][0]
    assert edge["a"] == "UC_a" and edge["b"] == "UC_b"
    assert edge["evidence_count"] == 2
    assert edge["last_seen_video_at"] == TS.isoformat()
    assert len(edge["evidence"]) == 2
    assert edge["evidence"][0]["video_id"] == "vid1"
    assert edge["evidence"][0]["moderator_channel_id"] == "UC_b"
    assert edge["evidence"][1]["video_published_at"] is None


def test_build_graph_payload_drops_evidence_without_edge():
    # 未通過准入的觀察(沒有對應邊)不應出現在結果中
    evidence_rows = [("UC_x", "UC_y", "vid9", None, None, "UC_x")]
    payload = build_graph_payload([], [], evidence_rows)
    assert payload["edges"] == []
    assert payload["nodes"] == []
