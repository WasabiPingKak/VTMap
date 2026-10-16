"""
共用 fixtures：Flask test app、Firestore emulator client、seed helpers

測試用環境變數統一定義在 pyproject.toml [tool.pytest.ini_options] env，
由 pytest-env 自動注入，不再硬編碼於此。
"""

import os
from datetime import UTC, datetime
from unittest.mock import MagicMock

import pytest
from apiflask import APIFlask

from utils.exceptions import register_error_handlers
from utils.rate_limiter import limiter

# ═══════════════════════════════════════════════════════
# Firestore Emulator
# ═══════════════════════════════════════════════════════


@pytest.fixture(scope="session")
def _emulator_app():
    """Session-scoped：初始化 firebase_admin 指向 emulator"""
    import urllib.request

    import firebase_admin

    host = os.environ.get("FIRESTORE_EMULATOR_HOST")
    assert host, (
        "FIRESTORE_EMULATOR_HOST 未設定 — 請先啟動 Firestore emulator：\n"
        "  firebase emulators:start --only firestore --project demo-test"
    )
    # 快速檢查 emulator 是否可連線，避免測試 hang 住
    try:
        urllib.request.urlopen(f"http://{host}/", timeout=2)
    except Exception:
        pytest.skip(
            f"Firestore emulator 未啟動（{host}）。"
            "請執行：firebase emulators:start --only firestore --project demo-test"
        )
    if not firebase_admin._apps:
        # Emulator 不需要真實 credentials，用 AnonymousCredentials 避免 DefaultCredentialsError
        from google.auth.credentials import AnonymousCredentials

        class _EmulatorCredential(firebase_admin.credentials.Base):
            def get_credential(self):
                return AnonymousCredentials()

        firebase_admin.initialize_app(_EmulatorCredential(), options={"projectId": "demo-test"})


@pytest.fixture(scope="session")
def _emulator_db(_emulator_app):
    """Session-scoped：取得指向 emulator 的 Firestore client"""
    from firebase_admin import firestore

    return firestore.client()


KNOWN_COLLECTIONS = [
    "oauth_states",
    "channel_data",
    "channel_index",
    "live_redirect_notifications",
    "scheduler_job_logs",
    "channel_sync_index",
]


def _clear_emulator():
    """使用 emulator REST API 清除所有資料（比逐筆刪除可靠，不漏 virtual parent）"""
    import urllib.request

    host = os.environ.get("FIRESTORE_EMULATOR_HOST")
    url = f"http://{host}/emulator/v1/projects/demo-test/databases/(default)/documents"
    req = urllib.request.Request(url, method="DELETE")
    urllib.request.urlopen(req, timeout=5)


@pytest.fixture
def db(_emulator_db):
    """Function-scoped：提供真實 Firestore client，測試結束後自動清理"""
    yield _emulator_db
    _clear_emulator()


# ═══════════════════════════════════════════════════════
# 向下相容：未遷移的測試仍可使用 mock_db
# ═══════════════════════════════════════════════════════


@pytest.fixture
def mock_db():
    """回傳 MagicMock Firestore client（供尚未遷移的測試使用）"""
    return MagicMock()


# ═══════════════════════════════════════════════════════
# Seed helpers
# ═══════════════════════════════════════════════════════


def seed_channel_meta(db, channel_id, *, revoked_at=None, refresh_token=None):
    """寫入 channel_data/{channel_id}/channel_info/meta"""
    data = {}
    if revoked_at is not None:
        data["revoked_at"] = revoked_at
    if refresh_token is not None:
        data["refresh_token"] = refresh_token
    db.collection("channel_data").document(channel_id).collection("channel_info").document(
        "meta"
    ).set(data)


def seed_channel_index(db, channel_id, *, name="Test", thumbnail="https://example.com/t.jpg"):
    """寫入 channel_index/{channel_id}"""
    db.collection("channel_index").document(channel_id).set({"name": name, "thumbnail": thumbnail})


def seed_oauth_state(db, state_id, *, created_at=None):
    """寫入 oauth_states/{state_id}"""
    if created_at is None:
        created_at = datetime.now(UTC)
    db.collection("oauth_states").document(state_id).set({"created_at": created_at})


# ═══════════════════════════════════════════════════════
# Autouse fixtures：每次測試前重置全域狀態
# ═══════════════════════════════════════════════════════


@pytest.fixture(autouse=True)
def _clear_revoke_cache():
    """每個測試前清空撤銷快取，避免跨測試污染"""
    from utils.auth_decorator import _revoke_cache

    _revoke_cache.clear()


@pytest.fixture(autouse=True)
def _clear_discord_notify_cache():
    """每個測試前清空 Discord 通知開關快取，避免跨測試污染"""
    from services.discord_notify.config_store import _enabled_cache

    _enabled_cache.clear()


@pytest.fixture(autouse=True)
def _reset_breakers():
    """每個測試前重置 circuit breaker 狀態"""
    from utils.breaker_instances import firestore_breaker, youtube_breaker

    firestore_breaker.reset()
    youtube_breaker.reset()


@pytest.fixture(autouse=True)
def _reset_kms_cache():
    """每個測試前重置 KMS key name 快取"""
    import utils.kms_crypto as kms_mod

    kms_mod._kms_key_name = None


# ═══════════════════════════════════════════════════════
# Flask test app（使用 mock_db 的版本，供向下相容）
# ═══════════════════════════════════════════════════════


def create_test_app(**extra_config):
    """建立路由測試用的 APIFlask app（含 TESTING + rate limiter + 全域 error handler）

    可傳入額外 config，例如 FRONTEND_BASE_URL。
    各測試檔在自己的 fixture 中呼叫此函式後再註冊所需路由。
    """
    app = APIFlask(__name__)
    app.config["TESTING"] = True
    app.config["PROPAGATE_EXCEPTIONS"] = False
    app.config["RATELIMIT_ENABLED"] = False
    for key, value in extra_config.items():
        app.config[key] = value
    limiter.init_app(app)
    register_error_handlers(app)
    return app


def create_test_app_with_routes(db_client, **extra_config):
    """建立帶有常用路由的 test app（使用真實或 mock db）"""
    from routes.me_route import init_me_route
    from routes.oauth_callback_route import init_oauth_callback_route
    from routes.oauth_state_route import init_oauth_state_route

    app = create_test_app(FRONTEND_BASE_URL="http://localhost:5173", **extra_config)
    init_oauth_callback_route(app, db_client)
    init_oauth_state_route(app, db_client)
    init_me_route(app, db_client)
    return app


@pytest.fixture
def app(mock_db):
    """建立使用 mock_db 的 test app（向下相容）"""
    return create_test_app_with_routes(mock_db)


@pytest.fixture
def client(app):
    """Flask test client"""
    return app.test_client()
