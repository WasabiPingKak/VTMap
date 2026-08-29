"""Supabase Postgres 連線共用邏輯(Flask 端)。"""

import os

import psycopg
from psycopg import sql

from utils.exceptions import ConfigurationError

CONNECT_TIMEOUT_SECONDS = 10


def get_connection() -> psycopg.Connection:
    """建立連線並將 search_path 指向目標 schema(staging / public)。"""
    db_url = os.getenv("SUPABASE_DB_URL")
    if not db_url:
        raise ConfigurationError(
            "關係網路資料庫未設定",
            log_message="缺少 SUPABASE_DB_URL 環境變數",
        )
    schema = os.getenv("NETWORK_DB_SCHEMA", "staging")
    conn = psycopg.connect(db_url, connect_timeout=CONNECT_TIMEOUT_SECONDS)
    with conn.cursor() as cur:
        cur.execute(sql.SQL("set search_path to {}").format(sql.Identifier(schema)))
    conn.commit()
    return conn
