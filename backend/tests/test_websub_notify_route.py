"""
WebSub callback route 測試：驗證 GET 驗證、POST 推播寫入、簽名驗證

使用 Firestore emulator 取代 MagicMock。
HMAC 簽章驗證使用真實的 hmac.new()（本來就沒有 mock）。
"""

import hashlib
import hmac
import importlib
from unittest.mock import patch

import pytest
from conftest import create_test_app

SAMPLE_XML = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"
      xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <yt:videoId>dQw4w9WgXcQ</yt:videoId>
    <yt:channelId>UCuAXFkgsw1L7xaCfnd5JJOw</yt:channelId>
    <title>Test Video</title>
  </entry>
</feed>"""


@pytest.fixture
def websub_app(db):
    import routes.websub_notify_route as mod

    importlib.reload(mod)

    app = create_test_app()
    mod.init_websub_notify_route(app, db)
    return app


@pytest.fixture
def websub_client(websub_app):
    return websub_app.test_client()


class TestWebSubGetVerification:
    """GET /websub-callback 驗證訂閱"""

    def test_returns_challenge(self, websub_client):
        resp = websub_client.get(
            "/websub-callback?hub.mode=subscribe&hub.challenge=abc123&hub.topic=test"
        )
        assert resp.status_code == 200
        assert resp.data == b"abc123"

    def test_missing_challenge_returns_400(self, websub_client):
        resp = websub_client.get("/websub-callback?hub.mode=subscribe")
        assert resp.status_code == 400


class TestWebSubPostNotification:
    """POST /websub-callback 推播處理"""

    def test_valid_xml_writes_to_firestore(self, db, websub_client):
        resp = websub_client.post(
            "/websub-callback",
            data=SAMPLE_XML,
            content_type="application/atom+xml",
        )
        assert resp.status_code == 204

        # 從 Firestore emulator 讀回驗證寫入
        docs = list(db.collection("live_redirect_notifications").limit(10).stream())
        assert len(docs) >= 1

        # 驗證 doc ID 包含 videoId
        doc_ids = [doc.id for doc in docs]
        matching = [d for d in doc_ids if "dQw4w9WgXcQ" in d]
        assert len(matching) >= 1

        # 驗證 doc 內容
        data = docs[0].to_dict()
        assert data["videoId"] == "dQw4w9WgXcQ"
        assert data["channelId"] == "UCuAXFkgsw1L7xaCfnd5JJOw"

    def test_invalid_signature_returns_403(self, websub_client):
        """設定 WEBSUB_SECRET 後，錯誤簽名應被拒絕"""
        with patch.dict("os.environ", {"WEBSUB_SECRET": "my-secret"}):
            resp = websub_client.post(
                "/websub-callback",
                data=SAMPLE_XML,
                content_type="application/atom+xml",
                headers={"X-Hub-Signature": "sha1=wrong"},
            )
            assert resp.status_code == 403

    def test_valid_signature_passes(self, db, websub_client):
        with patch.dict("os.environ", {"WEBSUB_SECRET": "my-secret"}):
            xml_bytes = SAMPLE_XML.encode()
            sig = "sha1=" + hmac.new(b"my-secret", xml_bytes, hashlib.sha1).hexdigest()

            resp = websub_client.post(
                "/websub-callback",
                data=xml_bytes,
                content_type="application/atom+xml",
                headers={"X-Hub-Signature": sig},
            )
            assert resp.status_code == 204


class TestWebSubDiscordEnqueue:
    """有開 Discord 通知的頻道，推播時排入 discord_notify_queue"""

    def _post(self, client):
        return client.post("/websub-callback", data=SAMPLE_XML, content_type="application/atom+xml")

    def test_enabled_channel_enqueued(self, db, websub_client):
        from services.discord_notify.config_store import update_kind_config

        update_kind_config(
            db, "UCuAXFkgsw1L7xaCfnd5JJOw", "video", {"enabled": True, "discord_channel_id": "9"}
        )
        assert self._post(websub_client).status_code == 204
        assert db.collection("discord_notify_queue").document("dQw4w9WgXcQ").get().exists

    def test_disabled_channel_not_enqueued(self, db, websub_client):
        assert self._post(websub_client).status_code == 204
        assert not db.collection("discord_notify_queue").document("dQw4w9WgXcQ").get().exists

    def test_enqueue_failure_does_not_break_callback(self, db, websub_client):
        with patch("routes.websub_notify_route.is_notify_enabled", side_effect=RuntimeError("x")):
            assert self._post(websub_client).status_code == 204
