# services/discord_notify/discord_api.py
# Discord REST API 封裝（只用 HTTP，不需要 Gateway 長連線）

import logging
import os

import requests

from utils.exceptions import ConfigurationError, ExternalServiceError

DISCORD_API_BASE = "https://discord.com/api/v10"

# 頻道類型：0 = 文字頻道，5 = 公告頻道
TEXT_CHANNEL_TYPES = (0, 5)


def _headers() -> dict:
    token = os.getenv("DISCORD_BOT_TOKEN", "")
    if not token:
        raise ConfigurationError("Discord 機器人尚未設定", log_message="未設定 DISCORD_BOT_TOKEN")
    return {"Authorization": f"Bot {token}", "Content-Type": "application/json"}


def _request(method: str, path: str, **kwargs) -> requests.Response:
    try:
        resp = requests.request(
            method, f"{DISCORD_API_BASE}{path}", headers=_headers(), timeout=10, **kwargs
        )
    except requests.RequestException as e:
        raise ExternalServiceError(
            "Discord 暫時連不上，請稍後再試", log_message=f"Discord 連線失敗：{e}"
        ) from e
    if not resp.ok:
        logging.warning(f"⚠️ Discord API {method} {path} 失敗：{resp.status_code} {resp.text}")
        raise ExternalServiceError(
            "Discord 拒絕了這個操作，請確認機器人有該頻道的權限",
            log_message=f"Discord API 回應 {resp.status_code}",
        )
    return resp


def send_message(channel_id: str, content: str, allowed_mentions: dict) -> str:
    """發送訊息，回傳 message id"""
    resp = _request(
        "POST",
        f"/channels/{channel_id}/messages",
        json={"content": content, "allowed_mentions": allowed_mentions},
    )
    return str(resp.json().get("id", ""))


def list_text_channels(guild_id: str) -> list[dict]:
    channels = _request("GET", f"/guilds/{guild_id}/channels").json()
    result = [
        {"id": c["id"], "name": c["name"], "position": c.get("position", 0)}
        for c in channels
        if c.get("type") in TEXT_CHANNEL_TYPES
    ]
    return sorted(result, key=lambda c: c["position"])


def list_roles(guild_id: str) -> list[dict]:
    roles = _request("GET", f"/guilds/{guild_id}/roles").json()
    # managed = 機器人或整合服務自動建立的身分組，不能拿來 tag
    result = [
        {"id": r["id"], "name": r["name"], "position": r.get("position", 0)}
        for r in roles
        if not r.get("managed")
    ]
    return sorted(result, key=lambda r: -r["position"])
