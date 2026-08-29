"""資料庫連線與 migration 執行。"""

import logging
from pathlib import Path

import psycopg
from psycopg import sql

from crawler.config import DB_SCHEMA, get_db_url

logger = logging.getLogger(__name__)

# repo 根目錄的 supabase/migrations/(與 supabase CLI 慣例相容)
MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "supabase" / "migrations"


def get_conn() -> psycopg.Connection:
    """建立連線並將 search_path 指向目標 schema。

    migration 檔不含 schema 前綴,同一份檔案可套用到 staging 或 public,
    由 CRAWLER_DB_SCHEMA 決定目標。
    """
    conn = psycopg.connect(get_db_url(), connect_timeout=15)
    with conn.cursor() as cur:
        cur.execute(sql.SQL("set search_path to {}").format(sql.Identifier(DB_SCHEMA)))
    conn.commit()
    return conn


def run_migrations(conn: psycopg.Connection, migrations_dir: Path = MIGRATIONS_DIR) -> list[str]:
    """依檔名排序套用尚未執行的 migration,回傳本次套用的檔名清單。"""
    with conn.cursor() as cur:
        cur.execute(sql.SQL("create schema if not exists {}").format(sql.Identifier(DB_SCHEMA)))
    with conn.cursor() as cur:
        cur.execute(
            """
            create table if not exists schema_migrations (
              filename text primary key,
              applied_at timestamptz not null default now()
            )
            """
        )
        cur.execute("select filename from schema_migrations")
        applied = {row[0] for row in cur.fetchall()}

    newly_applied = []
    for sql_file in sorted(migrations_dir.glob("*.sql")):
        if sql_file.name in applied:
            continue
        logger.info("套用 migration:%s", sql_file.name)
        with conn.cursor() as cur:
            cur.execute(sql_file.read_text(encoding="utf-8"))
            cur.execute(
                "insert into schema_migrations (filename) values (%s)",
                (sql_file.name,),
            )
        conn.commit()
        newly_applied.append(sql_file.name)

    return newly_applied
