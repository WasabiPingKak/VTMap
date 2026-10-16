# services/discord_notify/config_store.py
# Discord 通知設定的讀寫與訊息模板渲染

import os
import re
from datetime import UTC, datetime

from cachetools import TTLCache
from google.cloud.firestore import Client

from services.discord_notify.classifier import KIND_LIVE, KIND_VIDEO, KINDS

CONFIG_COLLECTION = "discord_notify_config"

DEFAULT_TEMPLATES = {
    KIND_LIVE: "{role} {channel} 開台了！\n{title}\n{url}",
    KIND_VIDEO: "{role} {channel} 發布了新{type}！\n{title}\n{url}",
}

TEMPLATE_MAX_LENGTH = 1500
PLACEHOLDER_PATTERN = re.compile(r"\{(title|url|channel|type|role)\}")

# 「頻道是否有開通知」的快取，WebSub 推播每筆都會查，減少 Firestore 讀取
_enabled_cache: TTLCache = TTLCache(maxsize=256, ttl=60)


def default_kind_config(kind: str) -> dict:
    return {
        "enabled": False,
        "discord_channel_id": None,
        "role_id": None,
        "template": DEFAULT_TEMPLATES[kind],
    }


def _normalize(channel_id: str, data: dict) -> dict:
    result = {
        "youtube_channel_id": channel_id,
        "guild_id": data.get("guild_id") or os.getenv("DISCORD_GUILD_ID", ""),
    }
    for kind in KINDS:
        merged = default_kind_config(kind)
        merged.update(data.get(kind) or {})
        result[kind] = merged
    return result


def get_config(db: Client, channel_id: str) -> dict:
    doc = db.collection(CONFIG_COLLECTION).document(channel_id).get()
    data = doc.to_dict() or {}  # type: ignore[union-attr]
    return _normalize(channel_id, data)


def find_config_by_guild(db: Client, guild_id: str) -> dict | None:
    docs = db.collection(CONFIG_COLLECTION).where("guild_id", "==", guild_id).limit(1).stream()
    for doc in docs:
        return _normalize(doc.id, doc.to_dict() or {})
    return None


def update_kind_config(db: Client, channel_id: str, kind: str, fields: dict) -> dict:
    """合併更新某一類通知的設定，回傳更新後的完整設定"""
    current = get_config(db, channel_id)
    current[kind].update(fields)
    db.collection(CONFIG_COLLECTION).document(channel_id).set(
        {
            "guild_id": current["guild_id"],
            kind: current[kind],
            "updated_at": datetime.now(UTC).isoformat(),
        },
        merge=True,
    )
    _enabled_cache.pop(channel_id, None)
    return current


def is_notify_enabled(db: Client, channel_id: str) -> bool:
    """這個 YouTube 頻道是否有任何一類通知開啟"""
    cached = _enabled_cache.get(channel_id)
    if cached is not None:
        return bool(cached)
    config = get_config(db, channel_id)
    enabled = any(config[kind]["enabled"] and config[kind]["discord_channel_id"] for kind in KINDS)
    _enabled_cache[channel_id] = enabled
    return enabled


def render_message(kind_config: dict, guild_id: str, context: dict) -> tuple[str, dict]:
    """
    以模板產生訊息內容與 allowed_mentions。

    context 需包含 title / url / channel / type。
    身分組 tag 填在 {role} 的位置，模板沒有 {role} 時放在開頭。
    @everyone 身分組的 id 等於伺服器 id，需改用 @everyone 文字才會生效。
    """
    role_id = kind_config.get("role_id")
    if not role_id:
        role_text = ""
        allowed_mentions: dict = {"parse": []}
    elif role_id == guild_id:
        role_text = "@everyone"
        allowed_mentions = {"parse": ["everyone"]}
    else:
        role_text = f"<@&{role_id}>"
        allowed_mentions = {"parse": [], "roles": [role_id]}

    template = kind_config.get("template") or DEFAULT_TEMPLATES[KIND_VIDEO]
    if role_text and "{role}" not in template:
        template = "{role} " + template

    values = {**{k: str(v) for k, v in context.items()}, "role": role_text}
    content = PLACEHOLDER_PATTERN.sub(lambda m: values.get(m.group(1), ""), template)

    # 沒有身分組時，移除 {role} 留下的開頭空白
    return content.strip(), allowed_mentions
