"""Flask 端的關係網路查詢:連線 Supabase Postgres 並組出圖資料。"""

import logging

import psycopg

from services.network.graph_query import (
    fetch_graph_payload,
    fetch_queue_rank,
    fetch_recent_payload,
)
from services.network.supabase import get_connection
from utils.exceptions import ExternalServiceError

logger = logging.getLogger(__name__)

# 最新加入面板的預設 / 上限筆數:20 已足夠常見瀏覽,上限 100 防呆
DEFAULT_RECENT_LIMIT = 20
MAX_RECENT_LIMIT = 100


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


def get_recent_nodes(limit: int = DEFAULT_RECENT_LIMIT) -> dict:
    """回傳最近加入的頻道(依 created_at 降冪,只含有出現在圖上的節點)。"""
    limit = max(1, min(int(limit), MAX_RECENT_LIMIT))
    try:
        with get_connection() as conn:
            return fetch_recent_payload(conn, limit)
    except psycopg.Error as e:
        logger.error("最近加入頻道查詢失敗:%s", e)
        raise ExternalServiceError(
            "最近加入頻道資料暫時無法取得",
            log_message=f"Supabase 查詢失敗:{e}",
        ) from e


def get_queue_rank(channel_id: str) -> dict:
    """回傳頻道在爬蟲佇列的累計順位;沒有 pending task 時 rank=null。"""
    try:
        with get_connection() as conn:
            rank = fetch_queue_rank(conn, channel_id)
    except psycopg.Error as e:
        logger.error("佇列順位查詢失敗:%s", e)
        raise ExternalServiceError(
            "佇列順位暫時無法取得",
            log_message=f"Supabase 查詢失敗:{e}",
        ) from e
    return {"rank": rank}
