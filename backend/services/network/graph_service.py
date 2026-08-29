"""Flask 端的關係網路查詢:連線 Supabase Postgres 並組出圖資料。"""

import logging
import os

import psycopg
from psycopg import sql

from services.network.graph_query import fetch_graph_payload
from utils.exceptions import ConfigurationError, ExternalServiceError

logger = logging.getLogger(__name__)

CONNECT_TIMEOUT_SECONDS = 10


def _get_db_settings() -> tuple[str, str]:
    db_url = os.getenv("SUPABASE_DB_URL")
    if not db_url:
        raise ConfigurationError(
            "關係網路資料庫未設定",
            log_message="缺少 SUPABASE_DB_URL 環境變數",
        )
    schema = os.getenv("NETWORK_DB_SCHEMA", "staging")
    return db_url, schema


def get_network_graph() -> dict:
    """回傳完整關係網路圖(nodes + edges,含證據清單)。"""
    db_url, schema = _get_db_settings()
    try:
        with psycopg.connect(db_url, connect_timeout=CONNECT_TIMEOUT_SECONDS) as conn:
            with conn.cursor() as cur:
                cur.execute(sql.SQL("set search_path to {}").format(sql.Identifier(schema)))
            return fetch_graph_payload(conn)
    except psycopg.Error as e:
        logger.error("關係網路資料庫查詢失敗:%s", e)
        raise ExternalServiceError(
            "關係網路資料暫時無法取得",
            log_message=f"Supabase 查詢失敗:{e}",
        ) from e
