"""Flask 端的關係網路查詢:連線 Supabase Postgres 並組出圖資料。"""

import logging

import psycopg

from services.network.graph_query import fetch_graph_payload
from services.network.supabase import get_connection
from utils.exceptions import ExternalServiceError

logger = logging.getLogger(__name__)


def get_network_graph() -> dict:
    """回傳完整關係網路圖(nodes + edges,含證據清單)。"""
    try:
        with get_connection() as conn:
            return fetch_graph_payload(conn)
    except psycopg.Error as e:
        logger.error("關係網路資料庫查詢失敗:%s", e)
        raise ExternalServiceError(
            "關係網路資料暫時無法取得",
            log_message=f"Supabase 查詢失敗:{e}",
        ) from e
