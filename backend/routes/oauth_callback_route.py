import logging
from datetime import UTC, datetime, timedelta

from apiflask import APIBlueprint
from flask import current_app, jsonify, make_response, redirect, request
from google.cloud import firestore

from services.firestore.auth_service import save_channel_auth
from services.google_oauth import exchange_code_for_tokens, get_channel_id
from services.network.queue_service import enqueue_registered_channel
from utils.jwt_util import JWT_EXP_HOURS, generate_jwt
from utils.rate_limiter import limiter

OAUTH_STATE_TTL_SECONDS = 600  # 10 分鐘


def init_oauth_callback_route(app, db: firestore.Client):
    oauth_bp = APIBlueprint("oauth", __name__, tag="Auth")

    @oauth_bp.route("/oauth/callback")
    @oauth_bp.doc(summary="OAuth 回調", description="處理 Google OAuth 授權回調", hide=True)
    @limiter.limit("10 per minute")
    def oauth_callback():
        # ✅ 測試模式：僅記錄收到 callback，不回傳敏感參數
        if current_app.config.get("OAUTH_DEBUG_MODE", False):
            logging.info("🧪 [Debug] OAuth callback triggered, state=%s", request.args.get("state"))
            return jsonify(
                {
                    "debug": "🧪 OAuth callback 測試模式",
                    "message": "callback 已收到，詳細參數請查看 server log",
                }
            )

        # ✅ 驗證 OAuth state（從 Firestore 讀取，防止 CSRF）
        state = request.args.get("state")
        if not state:
            logging.warning("⚠️ 缺少 OAuth state 參數")
            return "Missing OAuth state", 400

        state_ref = db.collection("oauth_states").document(state)
        state_doc = state_ref.get()
        if not state_doc.exists:  # type: ignore[union-attr]
            logging.warning("⚠️ OAuth state 不存在或已使用")
            return "Invalid OAuth state", 403

        # 檢查是否過期
        state_data = state_doc.to_dict() or {}  # type: ignore[union-attr]
        created_at = state_data.get("created_at")
        if created_at:
            now = datetime.now(UTC)
            if now - created_at > timedelta(seconds=OAUTH_STATE_TTL_SECONDS):
                state_ref.delete()
                logging.warning("⚠️ OAuth state 已過期")
                return "OAuth state expired", 403

        # 立即刪除，確保一次性使用
        state_ref.delete()

        code = request.args.get("code")
        if not code:
            logging.warning("⚠️ 缺少授權 code")
            return "Missing authorization code", 400

        token_data = exchange_code_for_tokens(code)
        access_token = token_data.get("access_token")
        refresh_token = token_data.get("refresh_token")

        if not access_token:
            logging.error("❌ 無法取得 access token")
            return "Failed to get access token", 400
        if not refresh_token:
            logging.warning("⚠️ 未提供 refresh token，可能使用者已授權過？")
            return "Missing refresh token. Please re-authorize with prompt=consent.", 400

        channel_id = get_channel_id(access_token)
        if not channel_id:
            logging.error("❌ 無法取得頻道 ID")
            return "Failed to fetch channel ID", 400

        save_channel_auth(db, channel_id, refresh_token)
        logging.info(f"✅ 頻道授權成功：{channel_id}")

        # 新頻道高優先排入關係網路爬取佇列;失敗不影響註冊流程
        try:
            enqueue_registered_channel(channel_id)
        except Exception as e:
            logging.warning(f"⚠️ 頻道 {channel_id} 排入爬取佇列失敗:{e}")

        # 🎯 簽出 JWT 並寫入登入 cookie
        jwt_token = generate_jwt(channel_id)
        frontend_base = current_app.config.get("FRONTEND_BASE_URL", "")
        redirect_url = f"{frontend_base}/auth-loading?channel={channel_id}"

        response = make_response(redirect(redirect_url))
        response.set_cookie(
            "__session",
            jwt_token,
            max_age=60 * 60 * JWT_EXP_HOURS,
            path="/",
            httponly=True,
            secure=True,
            samesite="Lax",
        )
        return response

    app.register_blueprint(oauth_bp)
