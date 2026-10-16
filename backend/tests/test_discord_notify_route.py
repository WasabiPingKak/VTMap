"""
Discord 通知 route 測試：設定 API 權限、tick、斜線指令驗簽與處理
"""

import json
from unittest.mock import patch

import pytest
from conftest import create_test_app
from Crypto.PublicKey import ECC
from Crypto.Signature import eddsa

from routes.discord_notify_route import init_discord_notify_route
from services.discord_notify.config_store import get_config, update_kind_config
from utils.jwt_util import generate_jwt

ADMIN_ID = "UC_ADMIN_001"
NON_ADMIN_ID = "UC_NORMAL_USER"
GUILD = "111"

# 模擬 Discord 的簽章金鑰
_PRIVATE_KEY = ECC.generate(curve="Ed25519")
_PUBLIC_KEY_HEX = _PRIVATE_KEY.public_key().export_key(format="raw").hex()


@pytest.fixture
def client(db, monkeypatch):
    monkeypatch.setenv("DISCORD_GUILD_ID", GUILD)
    monkeypatch.setenv("DISCORD_PUBLIC_KEY", _PUBLIC_KEY_HEX)
    app = create_test_app()
    init_discord_notify_route(app, db)
    return app.test_client()


def _login(client, channel_id):
    client.set_cookie("__session", generate_jwt(channel_id))


def _signed_post(client, payload: dict, *, tamper=False):
    body = json.dumps(payload).encode()
    timestamp = "1700000000"
    signature = eddsa.new(_PRIVATE_KEY, "rfc8032").sign(timestamp.encode() + body).hex()
    if tamper:
        body = body + b" "
    return client.post(
        "/api/discord/interactions",
        data=body,
        content_type="application/json",
        headers={"X-Signature-Ed25519": signature, "X-Signature-Timestamp": timestamp},
    )


def _command(sub, **options):
    return {
        "type": 2,
        "guild_id": GUILD,
        "data": {
            "name": "notify",
            "options": [
                {
                    "type": 1,
                    "name": sub,
                    "options": [{"name": k, "value": v} for k, v in options.items()],
                }
            ],
        },
    }


class TestConfigApi:
    def test_requires_login(self, client):
        assert client.get("/api/discord-notify/config").status_code == 401

    def test_non_admin_forbidden(self, client):
        _login(client, NON_ADMIN_ID)
        assert client.get("/api/discord-notify/config").status_code == 403

    def test_admin_gets_defaults(self, client):
        _login(client, ADMIN_ID)
        resp = client.get("/api/discord-notify/config")
        assert resp.status_code == 200
        assert resp.json["guild_id"] == GUILD
        assert resp.json["live"]["enabled"] is False

    def test_update_config(self, client, db):
        _login(client, ADMIN_ID)
        resp = client.put(
            "/api/discord-notify/config",
            json={
                "kind": "live",
                "enabled": True,
                "discord_channel_id": "555",
                "role_id": "666",
                "template": "  {title}  ",
            },
        )
        assert resp.status_code == 200
        live = get_config(db, ADMIN_ID)["live"]
        assert live["discord_channel_id"] == "555"
        assert live["template"] == "{title}"

    def test_enable_without_channel_rejected(self, client):
        _login(client, ADMIN_ID)
        resp = client.put(
            "/api/discord-notify/config",
            json={"kind": "video", "enabled": True, "template": "x"},
        )
        assert resp.status_code == 400

    def test_invalid_discord_id_rejected(self, client):
        _login(client, ADMIN_ID)
        resp = client.put(
            "/api/discord-notify/config",
            json={"kind": "video", "enabled": False, "role_id": "abc", "template": "x"},
        )
        assert resp.status_code == 422

    @patch("routes.discord_notify_route.list_roles", return_value=[{"id": "1", "name": "r"}])
    @patch("routes.discord_notify_route.list_text_channels", return_value=[{"id": "2"}])
    def test_guild_options(self, _ch, _roles, client):
        _login(client, ADMIN_ID)
        resp = client.get("/api/discord-notify/guild-options")
        assert resp.status_code == 200
        assert resp.json["channels"] == [{"id": "2"}]


class TestTickRoute:
    def test_requires_admin_key(self, client):
        assert client.post("/api/internal/discord-notify/tick").status_code == 401

    @patch("routes.discord_notify_route.run_tick", return_value={"checked": 0})
    def test_runs_tick(self, mock_tick, client):
        resp = client.post(
            "/api/internal/discord-notify/tick",
            headers={"Authorization": "Bearer test-admin-api-key"},
        )
        assert resp.status_code == 200
        mock_tick.assert_called_once()


class TestInteractions:
    def test_invalid_signature_rejected(self, client):
        assert _signed_post(client, {"type": 1}, tamper=True).status_code == 401

    def test_missing_signature_rejected(self, client):
        resp = client.post("/api/discord/interactions", json={"type": 1})
        assert resp.status_code == 401

    def test_ping_returns_pong(self, client):
        resp = _signed_post(client, {"type": 1})
        assert resp.json == {"type": 1}

    def test_unbound_guild(self, client):
        resp = _signed_post(client, _command("status"))
        assert "還沒有綁定" in resp.json["data"]["content"]

    def test_channel_command_updates_config(self, client, db):
        update_kind_config(db, ADMIN_ID, "live", {})
        resp = _signed_post(client, _command("channel", type="live", channel="999"))

        assert resp.json["data"]["flags"] == 64
        assert get_config(db, ADMIN_ID)["live"]["discord_channel_id"] == "999"

    def test_role_command_without_role_clears(self, client, db):
        update_kind_config(db, ADMIN_ID, "video", {"role_id": "5"})
        _signed_post(client, _command("role", type="video"))
        assert get_config(db, ADMIN_ID)["video"]["role_id"] is None

    def test_template_command_opens_modal_then_saves(self, client, db):
        update_kind_config(db, ADMIN_ID, "live", {"template": "舊模板"})
        resp = _signed_post(client, _command("template", type="live"))
        assert resp.json["type"] == 9
        text_input = resp.json["data"]["components"][0]["components"][0]
        assert text_input["value"] == "舊模板"

        submit = {
            "type": 5,
            "guild_id": GUILD,
            "data": {
                "custom_id": resp.json["data"]["custom_id"],
                "components": [
                    {"type": 1, "components": [{"custom_id": "template", "value": "新模板 {url}"}]}
                ],
            },
        }
        _signed_post(client, submit)
        assert get_config(db, ADMIN_ID)["live"]["template"] == "新模板 {url}"

    def test_status_command(self, client, db):
        update_kind_config(db, ADMIN_ID, "live", {"enabled": True, "discord_channel_id": "9"})
        resp = _signed_post(client, _command("status"))
        assert "<#9>" in resp.json["data"]["content"]

    def test_test_command_without_channel(self, client, db):
        update_kind_config(db, ADMIN_ID, "video", {})
        resp = _signed_post(client, _command("test", type="video"))
        assert "請先選擇" in resp.json["data"]["content"]
