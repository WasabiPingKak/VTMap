"""爬取佇列管理端點測試:GET /api/network/admin/queue"""

from unittest.mock import patch

import pytest
from conftest import create_test_app, seed_channel_meta

from routes.network_queue_route import init_network_queue_route
from utils.jwt_util import generate_jwt

ADMIN_ID = "UC_ADMIN_001"
NON_ADMIN_ID = "UC_NOT_ADMIN"


@pytest.fixture
def app(db):
    app = create_test_app()
    init_network_queue_route(app, db)
    return app


@pytest.fixture
def client(app):
    return app.test_client()


class TestNetworkQueueAuth:
    def test_no_cookie_returns_401(self, client):
        resp = client.get("/api/network/admin/queue")
        assert resp.status_code == 401

    def test_non_admin_returns_403(self, db, client):
        seed_channel_meta(db, NON_ADMIN_ID)
        client.set_cookie("__session", generate_jwt(NON_ADMIN_ID))

        resp = client.get("/api/network/admin/queue")
        assert resp.status_code == 403
        assert resp.get_json()["error"] == "權限不足"


class TestNetworkQueueDetail:
    @patch("routes.network_queue_route.get_queue_detail")
    def test_admin_gets_queue_payload(self, mock_detail, db, client):
        seed_channel_meta(db, ADMIN_ID)
        client.set_cookie("__session", generate_jwt(ADMIN_ID))

        mock_detail.return_value = {
            "tasks": [
                {
                    "id": 1,
                    "kind": "list_videos",
                    "status": "pending",
                    "priority": 100,
                    "attempts": 0,
                    "channel_id": "UC_x",
                    "video_id": None,
                    "last_error": None,
                    "created_at": None,
                    "updated_at": None,
                    "channel_title": "頻道X",
                    "channel_handle": "@x",
                    "channel_thumbnail": None,
                }
            ],
            "summary": [{"kind": "list_videos", "status": "pending", "count": 1}],
            "recent_done": [],
        }

        resp = client.get("/api/network/admin/queue")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["success"] is True
        assert data["tasks"][0]["priority"] == 100
        assert data["summary"][0]["count"] == 1
