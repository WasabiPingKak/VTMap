import logging
from datetime import UTC, datetime

from apiflask import APIBlueprint
from flask import jsonify, request
from google.cloud.firestore import Client

from schemas.discord_notify_schemas import DiscordNotifyTestRequest, UpdateDiscordNotifyRequest
from services.discord_notify.config_store import get_config, update_kind_config
from services.discord_notify.discord_api import list_roles, list_text_channels
from services.discord_notify.interactions import handle_interaction, verify_signature
from services.discord_notify.processor import run_tick, send_test_message
from utils.admin_auth import require_admin_key
from utils.auth_decorator import require_auth
from utils.exceptions import AppError, AuthorizationError, ConfigurationError
from utils.jwt_util import is_admin_channel_id
from utils.rate_limiter import limiter

logger = logging.getLogger(__name__)


def _require_admin(auth_channel_id: str) -> None:
    # 目前只開放管理員使用，之後開放給所有人時移除這個檢查即可
    if not is_admin_channel_id(auth_channel_id):
        raise AuthorizationError("這個功能目前尚未開放")


def init_discord_notify_route(app, db: Client):
    bp = APIBlueprint("discord_notify", __name__, tag="DiscordNotify")

    @bp.route("/api/discord-notify/config", methods=["GET"])
    @bp.doc(summary="取得 Discord 通知設定", security="CookieAuth")
    @require_auth(db)
    def get_discord_notify_config(auth_channel_id=None):
        _require_admin(auth_channel_id)
        return jsonify(get_config(db, auth_channel_id))

    @bp.route("/api/discord-notify/config", methods=["PUT"])
    @bp.doc(summary="更新 Discord 通知設定", security="CookieAuth")
    @require_auth(db)
    @bp.input(UpdateDiscordNotifyRequest, arg_name="body")
    def update_discord_notify_config(body, auth_channel_id=None):
        _require_admin(auth_channel_id)
        if body.enabled and not body.discord_channel_id:
            raise AppError("開啟通知前請先選擇要發送的 Discord 頻道", status_code=400)
        config = update_kind_config(
            db,
            auth_channel_id,
            body.kind,
            {
                "enabled": body.enabled,
                "discord_channel_id": body.discord_channel_id,
                "role_id": body.role_id,
                "template": body.template.strip(),
            },
        )
        return jsonify(config)

    @bp.route("/api/discord-notify/guild-options", methods=["GET"])
    @bp.doc(summary="取得 Discord 伺服器的頻道與身分組清單", security="CookieAuth")
    @require_auth(db)
    def get_discord_guild_options(auth_channel_id=None):
        _require_admin(auth_channel_id)
        guild_id = get_config(db, auth_channel_id)["guild_id"]
        if not guild_id:
            raise ConfigurationError(
                "Discord 伺服器尚未設定", log_message="未設定 DISCORD_GUILD_ID"
            )
        return jsonify(
            {
                "guild_id": guild_id,
                "channels": list_text_channels(guild_id),
                "roles": list_roles(guild_id),
            }
        )

    @bp.route("/api/discord-notify/test", methods=["POST"])
    @bp.doc(summary="發送 Discord 測試通知", security="CookieAuth")
    @limiter.limit("10 per minute")
    @require_auth(db)
    @bp.input(DiscordNotifyTestRequest, arg_name="body")
    def send_discord_test(body, auth_channel_id=None):
        _require_admin(auth_channel_id)
        message_id = send_test_message(db, auth_channel_id, body.kind)
        return jsonify({"success": True, "message_id": message_id})

    @bp.route("/api/internal/discord-notify/tick", methods=["POST"])
    @bp.doc(
        summary="處理 Discord 通知佇列",
        description="由 Cloud Scheduler 每分鐘呼叫：處理新影片、檢查待機室是否開台",
        security="BearerAuth",
    )
    @require_admin_key
    def discord_notify_tick():
        return jsonify(run_tick(db, datetime.now(UTC)))

    @bp.route("/api/discord/interactions", methods=["POST"])
    @bp.doc(summary="Discord 斜線指令回調", hide=True)
    @limiter.exempt
    def discord_interactions():
        body = request.get_data()
        signature = request.headers.get("X-Signature-Ed25519", "")
        timestamp = request.headers.get("X-Signature-Timestamp", "")
        if not verify_signature(body, signature, timestamp):
            logger.warning("⚠️ Discord interaction 簽名驗證失敗")
            return jsonify({"error": "invalid request signature"}), 401
        return jsonify(handle_interaction(db, request.get_json(silent=True) or {}))

    app.register_blueprint(bp)
