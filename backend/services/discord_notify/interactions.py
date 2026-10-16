# services/discord_notify/interactions.py
# Discord 斜線指令（Interactions Endpoint）：驗簽與指令處理
#
# Discord 會把使用者打的指令 POST 到我們的網址，需在 3 秒內回應。
# 指令定義見 tools/register_discord_commands.py。

import logging
import os

from Crypto.Signature import eddsa
from google.cloud.firestore import Client

from services.discord_notify.classifier import KIND_LIVE, KIND_VIDEO
from services.discord_notify.config_store import (
    TEMPLATE_MAX_LENGTH,
    find_config_by_guild,
    update_kind_config,
)
from services.discord_notify.processor import send_test_message
from utils.exceptions import AppError

# Interaction 類型
TYPE_PING = 1
TYPE_APPLICATION_COMMAND = 2
TYPE_MODAL_SUBMIT = 5

# 回應類型
RESPONSE_PONG = 1
RESPONSE_MESSAGE = 4
RESPONSE_MODAL = 9

FLAG_EPHEMERAL = 64  # 只有下指令的人看得到

KIND_NAMES = {KIND_LIVE: "直播開台", KIND_VIDEO: "影片"}
TEMPLATE_MODAL_PREFIX = "notify_template:"


def verify_signature(body: bytes, signature: str, timestamp: str) -> bool:
    public_key_hex = os.getenv("DISCORD_PUBLIC_KEY", "")
    if not public_key_hex or not signature or not timestamp:
        return False
    try:
        key = eddsa.import_public_key(bytes.fromhex(public_key_hex))
        verifier = eddsa.new(key, "rfc8032")
        verifier.verify(timestamp.encode() + body, bytes.fromhex(signature))
        return True
    except (ValueError, TypeError):
        return False


def _reply(content: str) -> dict:
    return {"type": RESPONSE_MESSAGE, "data": {"content": content, "flags": FLAG_EPHEMERAL}}


def _options(data: dict) -> tuple[str, dict]:
    """攤平 /notify <subcommand> 的參數"""
    sub = (data.get("options") or [{}])[0]
    values = {opt["name"]: opt.get("value") for opt in sub.get("options") or []}
    return sub.get("name", ""), values


def _format_status(config: dict) -> str:
    lines = ["**目前的通知設定**"]
    for kind, name in KIND_NAMES.items():
        kc = config[kind]
        channel = f"<#{kc['discord_channel_id']}>" if kc["discord_channel_id"] else "未設定"
        if not kc["role_id"]:
            role = "不 tag"
        elif kc["role_id"] == config["guild_id"]:
            role = "@everyone"
        else:
            role = f"<@&{kc['role_id']}>"
        state = "開啟" if kc["enabled"] else "關閉"
        lines.append(f"\n__{name}__（{state}）\n頻道：{channel}\n身分組：{role}")
        lines.append(f"模板：\n```\n{kc['template']}\n```")
    return "\n".join(lines)


def _template_modal(kind: str, current: str) -> dict:
    return {
        "type": RESPONSE_MODAL,
        "data": {
            "custom_id": f"{TEMPLATE_MODAL_PREFIX}{kind}",
            "title": f"{KIND_NAMES[kind]}通知模板",
            "components": [
                {
                    "type": 1,
                    "components": [
                        {
                            "type": 4,
                            "custom_id": "template",
                            "label": "可用 {title} {url} {channel} {type} {role}",
                            "style": 2,
                            "value": current,
                            "max_length": TEMPLATE_MAX_LENGTH,
                            "required": True,
                        }
                    ],
                }
            ],
        },
    }


def _handle_command(db: Client, config: dict, data: dict) -> dict:
    channel_id = config["youtube_channel_id"]
    sub, opts = _options(data)
    kind = opts.get("type")

    if sub == "status":
        return _reply(_format_status(config))

    if kind not in KIND_NAMES:
        return _reply("請選擇通知類型")
    name = KIND_NAMES[kind]

    if sub == "channel":
        update_kind_config(db, channel_id, kind, {"discord_channel_id": opts.get("channel")})
        return _reply(f"{name}通知會發到 <#{opts.get('channel')}>")

    if sub == "role":
        role_id = opts.get("role")
        update_kind_config(db, channel_id, kind, {"role_id": role_id})
        return _reply(f"{name}通知會 tag <@&{role_id}>" if role_id else f"{name}通知不 tag 身分組")

    if sub == "toggle":
        enabled = bool(opts.get("enabled"))
        update_kind_config(db, channel_id, kind, {"enabled": enabled})
        return _reply(f"{name}通知已{'開啟' if enabled else '關閉'}")

    if sub == "template":
        return _template_modal(kind, config[kind]["template"])

    if sub == "test":
        try:
            send_test_message(db, channel_id, kind)
        except AppError as e:
            return _reply(e.message)
        return _reply(f"已發送{name}測試通知")

    return _reply("不認得這個指令")


def _handle_modal(db: Client, config: dict, data: dict) -> dict:
    custom_id = data.get("custom_id", "")
    kind = custom_id.removeprefix(TEMPLATE_MODAL_PREFIX)
    if not custom_id.startswith(TEMPLATE_MODAL_PREFIX) or kind not in KIND_NAMES:
        return _reply("不認得這個表單")

    rows = data.get("components") or []
    value = ""
    for row in rows:
        for comp in row.get("components") or []:
            if comp.get("custom_id") == "template":
                value = (comp.get("value") or "").strip()
    if not value:
        return _reply("模板不能是空的")

    update_kind_config(db, config["youtube_channel_id"], kind, {"template": value})
    return _reply(f"{KIND_NAMES[kind]}通知模板已更新")


def handle_interaction(db: Client, payload: dict) -> dict:
    interaction_type = payload.get("type")
    if interaction_type == TYPE_PING:
        return {"type": RESPONSE_PONG}

    guild_id = payload.get("guild_id")
    if not guild_id:
        return _reply("請在伺服器裡使用這個指令")

    config = find_config_by_guild(db, guild_id)
    if not config:
        logging.warning(f"⚠️ 收到未綁定伺服器的指令：guild_id={guild_id}")
        return _reply("這個伺服器還沒有綁定，請先到 VTMap 網站的通知設定頁儲存一次設定")

    data = payload.get("data") or {}
    if interaction_type == TYPE_APPLICATION_COMMAND:
        return _handle_command(db, config, data)
    if interaction_type == TYPE_MODAL_SUBMIT:
        return _handle_modal(db, config, data)
    return _reply("不支援的操作")
