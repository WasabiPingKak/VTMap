"""
WebSub subscribe route 測試：批次訂閱、單一訂閱、subscribe_channel_by_id

subscribe_channel_by_id 的 HTTP 呼叫改用 responses 庫。
Firestore（channel_sync_index）改用 emulator。
保留 dispatch_tasks_batch mock（Cloud Tasks 無本地 emulator）。
保留 subscribe_channel_by_id mock 在 route 層測試（本體已有獨立測試）。
"""

import importlib
import os
from unittest.mock import patch

import pytest
import responses
from conftest import create_test_app

from routes.websub_subscribe_route import (
    HUB_PROBE_LIMIT,
    HUB_TIMEOUT_SECONDS,
    HUB_URL,
    subscribe_channel_by_id,
)

ADMIN_KEY = os.environ["ADMIN_API_KEY"]
ADMIN_HEADERS = {"Authorization": f"Bearer {ADMIN_KEY}"}


@pytest.fixture
def websub_app(db):
    import routes.websub_subscribe_route as mod

    importlib.reload(mod)

    app = create_test_app()
    mod.init_websub_subscribe_route(app, db)
    return app


@pytest.fixture
def websub_client(websub_app):
    return websub_app.test_client()


class TestSubscribeChannelById:
    """subscribe_channel_by_id 單元測試（使用 responses 攔截 HTTP）"""

    def test_empty_channel_id_returns_false(self):
        assert subscribe_channel_by_id("") is False

    @patch.dict(os.environ, {"WEBSUB_CALLBACK_URL": ""})
    def test_no_callback_url_returns_false(self):
        assert subscribe_channel_by_id("UCxxxxxxxxxxxxxxxxxxxxxx") is False

    @responses.activate
    @patch.dict(os.environ, {"WEBSUB_CALLBACK_URL": "https://example.com/websub"})
    def test_successful_subscribe(self):
        responses.add(responses.POST, HUB_URL, status=202)
        assert subscribe_channel_by_id("UCxxxxxxxxxxxxxxxxxxxxxx") is True

        # 驗證實際送出的 form data
        assert len(responses.calls) == 1
        body = responses.calls[0].request.body
        assert "hub.mode=subscribe" in body
        assert "UCxxxxxxxxxxxxxxxxxxxxxx" in body

    @responses.activate
    @patch.dict(os.environ, {"WEBSUB_CALLBACK_URL": "https://example.com/websub"})
    def test_failed_subscribe_returns_false(self):
        responses.add(responses.POST, HUB_URL, body="Bad request", status=400)
        assert subscribe_channel_by_id("UCxxxxxxxxxxxxxxxxxxxxxx") is False

    @responses.activate
    @patch.dict(os.environ, {"WEBSUB_CALLBACK_URL": "https://example.com/websub"})
    def test_network_error_returns_false(self):
        from requests.exceptions import ConnectionError as RequestsConnectionError

        responses.add(
            responses.POST,
            HUB_URL,
            body=RequestsConnectionError("timeout"),
        )
        assert subscribe_channel_by_id("UCxxxxxxxxxxxxxxxxxxxxxx") is False

    @responses.activate
    @patch.dict(os.environ, {"WEBSUB_CALLBACK_URL": "https://example.com/websub"})
    def test_read_timeout_returns_false(self):
        """hub 故障時的實際樣貌：連得上但遲遲不回應"""
        from requests.exceptions import ReadTimeout

        responses.add(responses.POST, HUB_URL, body=ReadTimeout("read timed out"))
        assert subscribe_channel_by_id("UCxxxxxxxxxxxxxxxxxxxxxx") is False

    @responses.activate
    @patch.dict(os.environ, {"WEBSUB_CALLBACK_URL": "https://example.com/websub"})
    def test_hub_503_returns_false(self):
        responses.add(
            responses.POST,
            HUB_URL,
            body="Transient error; please try again later",
            status=503,
        )
        assert subscribe_channel_by_id("UCxxxxxxxxxxxxxxxxxxxxxx") is False

    @patch("routes.websub_subscribe_route.requests.post")
    @patch.dict(os.environ, {"WEBSUB_CALLBACK_URL": "https://example.com/websub"})
    def test_uses_short_timeout(self, mock_post):
        """逾時直接決定 hub 故障時每次失敗佔用多久運算時間，不能退回長逾時"""
        mock_post.return_value.status_code = 202
        assert subscribe_channel_by_id("UCxxxxxxxxxxxxxxxxxxxxxx") is True
        assert mock_post.call_args.kwargs["timeout"] == HUB_TIMEOUT_SECONDS

    @responses.activate
    @patch.dict(
        os.environ,
        {"WEBSUB_CALLBACK_URL": "https://example.com/websub", "WEBSUB_SECRET": "my-secret"},
    )
    def test_includes_secret_when_set(self):
        responses.add(responses.POST, HUB_URL, status=202)
        subscribe_channel_by_id("UCxxxxxxxxxxxxxxxxxxxxxx")

        body = responses.calls[0].request.body
        assert "hub.secret=my-secret" in body


class TestSubscribeAll:
    """POST /api/websub/subscribe-all"""

    def test_no_auth_returns_401(self, websub_client):
        resp = websub_client.post("/api/websub/subscribe-all")
        assert resp.status_code == 401

    @patch.dict(os.environ, {"WEBSUB_CALLBACK_URL": ""})
    def test_no_callback_url_returns_400(self, websub_client):
        resp = websub_client.post(
            "/api/websub/subscribe-all",
            headers=ADMIN_HEADERS,
        )
        assert resp.status_code == 400

    @patch("routes.websub_subscribe_route.subscribe_channel_by_id")
    @patch("routes.websub_subscribe_route.dispatch_tasks_batch")
    @patch.dict(os.environ, {"WEBSUB_CALLBACK_URL": "https://example.com/websub"})
    def test_dispatches_tasks_for_channels(self, mock_dispatch, mock_sub, db, websub_client):
        # 在 Firestore emulator 寫入 channel_sync_index
        db.collection("channel_sync_index").document("index_list").set(
            {
                "channels": [
                    {"channel_id": "UC_CH_001"},
                    {"channel_id": "UC_CH_002"},
                ]
            }
        )
        mock_sub.return_value = True
        mock_dispatch.return_value = {"dispatched": 1, "failed": 0}

        resp = websub_client.post(
            "/api/websub/subscribe-all",
            headers=ADMIN_HEADERS,
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["dispatched"] == 1
        assert data["status"] == "success"

        # 第一個頻道探測時已訂閱成功，hub 正常就不再探測，只派發剩下的頻道
        mock_sub.assert_called_once_with("UC_CH_001")
        mock_dispatch.assert_called_once_with(
            "/api/websub/subscribe-one",
            params_list=[{"channel_id": "UC_CH_002"}],
        )

        # 驗證 job log 也寫入了 Firestore
        logs = list(db.collection("scheduler_job_logs").limit(10).stream())
        assert len(logs) >= 1

    @patch("routes.websub_subscribe_route.subscribe_channel_by_id")
    @patch("routes.websub_subscribe_route.dispatch_tasks_batch")
    @patch.dict(os.environ, {"WEBSUB_CALLBACK_URL": "https://example.com/websub"})
    def test_failed_probe_channel_is_still_dispatched(
        self, mock_dispatch, mock_sub, db, websub_client
    ):
        db.collection("channel_sync_index").document("index_list").set(
            {
                "channels": [
                    {"channel_id": "UC_CH_001"},
                    {"channel_id": "UC_CH_002"},
                    {"channel_id": "UC_CH_003"},
                ]
            }
        )
        # 第一個探測失敗、第二個成功：hub 視為正常，失敗的那個交給 Cloud Tasks 重試
        mock_sub.side_effect = [False, True]
        mock_dispatch.return_value = {"dispatched": 2, "failed": 0}

        resp = websub_client.post("/api/websub/subscribe-all", headers=ADMIN_HEADERS)

        assert resp.status_code == 200
        assert mock_sub.call_count == 2
        mock_dispatch.assert_called_once_with(
            "/api/websub/subscribe-one",
            params_list=[{"channel_id": "UC_CH_001"}, {"channel_id": "UC_CH_003"}],
        )

    @patch("routes.websub_subscribe_route.subscribe_channel_by_id")
    @patch("routes.websub_subscribe_route.dispatch_tasks_batch")
    @patch.dict(os.environ, {"WEBSUB_CALLBACK_URL": "https://example.com/websub"})
    def test_hub_down_skips_dispatch(self, mock_dispatch, mock_sub, db, websub_client):
        db.collection("channel_sync_index").document("index_list").set(
            {"channels": [{"channel_id": f"UC_CH_{i:03d}"} for i in range(10)]}
        )
        mock_sub.return_value = False

        resp = websub_client.post("/api/websub/subscribe-all", headers=ADMIN_HEADERS)

        assert resp.status_code == 502
        data = resp.get_json()
        assert data["status"] == "skipped"
        assert data["dispatched"] == 0
        # 只探測前幾個頻道就停手，不會把整份清單都打一遍
        assert mock_sub.call_count == HUB_PROBE_LIMIT
        mock_dispatch.assert_not_called()

        logs = [d.to_dict() for d in db.collection("scheduler_job_logs").stream()]
        assert [log["status"] for log in logs] == ["skipped"]

    @patch("routes.websub_subscribe_route.subscribe_channel_by_id")
    @patch("routes.websub_subscribe_route.dispatch_tasks_batch")
    @patch.dict(os.environ, {"WEBSUB_CALLBACK_URL": "https://example.com/websub"})
    def test_hub_down_with_fewer_channels_than_probe_limit(
        self, mock_dispatch, mock_sub, db, websub_client
    ):
        db.collection("channel_sync_index").document("index_list").set(
            {"channels": [{"channel_id": "UC_CH_001"}]}
        )
        mock_sub.return_value = False

        resp = websub_client.post("/api/websub/subscribe-all", headers=ADMIN_HEADERS)

        assert resp.status_code == 502
        assert mock_sub.call_count == 1
        mock_dispatch.assert_not_called()

    @patch.dict(os.environ, {"WEBSUB_CALLBACK_URL": "https://example.com/websub"})
    def test_empty_channels_returns_400(self, db, websub_client):
        db.collection("channel_sync_index").document("index_list").set({"channels": []})

        resp = websub_client.post(
            "/api/websub/subscribe-all",
            headers=ADMIN_HEADERS,
        )
        assert resp.status_code == 400


class TestSubscribeOne:
    """POST /api/websub/subscribe-one"""

    def test_no_auth_returns_401(self, websub_client):
        resp = websub_client.post("/api/websub/subscribe-one?channel_id=UCxxxxxxxxxxxxxxxxxxxxxx")
        assert resp.status_code == 401

    def test_missing_channel_id_returns_422(self, websub_client):
        resp = websub_client.post(
            "/api/websub/subscribe-one",
            headers=ADMIN_HEADERS,
        )
        assert resp.status_code == 422

    def test_invalid_channel_id_returns_422(self, websub_client):
        resp = websub_client.post(
            "/api/websub/subscribe-one?channel_id=invalid",
            headers=ADMIN_HEADERS,
        )
        assert resp.status_code == 422

    @patch("routes.websub_subscribe_route.subscribe_channel_by_id")
    def test_successful_subscribe(self, mock_sub, websub_client):
        mock_sub.return_value = True
        resp = websub_client.post(
            "/api/websub/subscribe-one?channel_id=UCxxxxxxxxxxxxxxxxxxxxxx",
            headers=ADMIN_HEADERS,
        )
        assert resp.status_code == 200
        assert resp.get_json()["status"] == "ok"

    @patch("routes.websub_subscribe_route.subscribe_channel_by_id")
    def test_failed_subscribe_returns_500(self, mock_sub, websub_client):
        mock_sub.return_value = False
        resp = websub_client.post(
            "/api/websub/subscribe-one?channel_id=UCxxxxxxxxxxxxxxxxxxxxxx",
            headers=ADMIN_HEADERS,
        )
        assert resp.status_code == 500
