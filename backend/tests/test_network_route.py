"""Network route 測試:GET /api/network/graph"""

import importlib
from unittest.mock import patch

import pytest
from conftest import create_test_app

from utils.exceptions import ConfigurationError, ExternalServiceError


@pytest.fixture(scope="module")
def network_app():
    import routes.network_route as mod

    importlib.reload(mod)

    app = create_test_app()
    mod.init_network_route(app)
    return app


@pytest.fixture
def client(network_app):
    return network_app.test_client()


class TestNetworkGraph:
    """GET /api/network/graph"""

    @patch("routes.network_route.get_network_graph")
    def test_returns_graph_payload(self, mock_graph, client):
        mock_graph.return_value = {
            "nodes": [{"channel_id": "UC_a", "title": "A", "thumbnail": None, "in_vtmap": True}],
            "edges": [
                {
                    "a": "UC_a",
                    "b": "UC_b",
                    "evidence_count": 2,
                    "last_seen_video_at": "2026-08-28T00:00:00+00:00",
                    "evidence": [],
                }
            ],
        }
        resp = client.get("/api/network/graph")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["success"] is True
        assert len(data["nodes"]) == 1
        assert data["edges"][0]["evidence_count"] == 2

    @patch("routes.network_route.get_network_graph")
    def test_missing_config_returns_500(self, mock_graph, client):
        mock_graph.side_effect = ConfigurationError("關係網路資料庫未設定")
        resp = client.get("/api/network/graph")
        assert resp.status_code == 500

    @patch("routes.network_route.get_network_graph")
    def test_db_error_returns_502(self, mock_graph, client):
        mock_graph.side_effect = ExternalServiceError("關係網路資料暫時無法取得")
        resp = client.get("/api/network/graph")
        assert resp.status_code == 502


class TestNetworkRecent:
    """GET /api/network/recent"""

    @patch("routes.network_route.get_recent_nodes")
    def test_returns_recent_nodes(self, mock_recent, client):
        mock_recent.return_value = {
            "nodes": [
                {
                    "channel_id": "UC_new",
                    "title": "剛加入",
                    "handle": "@newbie",
                    "thumbnail": None,
                    "subscriber_count": None,
                    "created_at": "2026-08-30T00:00:00",
                    "scanned": False,
                }
            ],
        }
        resp = client.get("/api/network/recent")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["success"] is True
        assert data["nodes"][0]["channel_id"] == "UC_new"
        # 預設 limit 傳入
        mock_recent.assert_called_once_with(20)

    @patch("routes.network_route.get_recent_nodes")
    def test_accepts_limit_query(self, mock_recent, client):
        mock_recent.return_value = {"nodes": []}
        client.get("/api/network/recent?limit=5")
        mock_recent.assert_called_once_with(5)

    @patch("routes.network_route.get_recent_nodes")
    def test_invalid_limit_falls_back_to_default(self, mock_recent, client):
        mock_recent.return_value = {"nodes": []}
        client.get("/api/network/recent?limit=abc")
        mock_recent.assert_called_once_with(20)


class TestNetworkQueueRank:
    """GET /api/network/queue-rank/<channel_id>"""

    @patch("routes.network_route.get_queue_rank")
    def test_returns_rank(self, mock_rank, client):
        mock_rank.return_value = {"rank": 42}
        resp = client.get("/api/network/queue-rank/UC_abc")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["success"] is True
        assert data["rank"] == 42
        mock_rank.assert_called_once_with("UC_abc")

    @patch("routes.network_route.get_queue_rank")
    def test_returns_null_when_no_pending_task(self, mock_rank, client):
        mock_rank.return_value = {"rank": None}
        resp = client.get("/api/network/queue-rank/UC_none")
        assert resp.status_code == 200
        assert resp.get_json()["rank"] is None
