"""爬蟲 CLI 進入點。

用法(在 backend/ 目錄下):
  python -m crawler migrate                        # 套用 supabase/migrations
  python -m crawler seed --api-base https://...    # 從 VTMap API 載入種子
  python -m crawler add-channel UCxxxx             # 手動加入單一種子頻道
  python -m crawler run [--max-tasks N] [--kinds fetch_chat ...] [--sleep S]
  python -m crawler expand                         # 補排未爬頻道 + 重算優先權
  python -m crawler status                         # 佇列與資料統計
  python -m crawler enrich-channels [--limit N]    # 補完頻道正式名稱與頭像(YouTube API)
  python -m crawler serve [--port 5001]            # 前端開發用迷你 API server
"""

import argparse
import logging

from crawler import pipeline, repo
from crawler.db import get_conn, run_migrations


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    parser = argparse.ArgumentParser(prog="crawler")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("migrate")

    p_seed = sub.add_parser("seed")
    p_seed.add_argument("--api-base", required=True, help="VTMap API base URL")
    p_seed.add_argument("--limit", type=int, default=None, help="只載入前 N 個頻道(測試用)")

    p_add = sub.add_parser("add-channel")
    p_add.add_argument("channel_id")

    p_run = sub.add_parser("run")
    p_run.add_argument("--max-tasks", type=int, default=None)
    p_run.add_argument(
        "--kinds",
        nargs="+",
        choices=[repo.KIND_LIST_VIDEOS, repo.KIND_FETCH_CHAT, repo.KIND_CHECK_QUALIFICATION],
        default=None,
    )
    p_run.add_argument("--sleep", type=float, default=None)

    sub.add_parser("status")

    sub.add_parser("expand")

    p_enrich = sub.add_parser("enrich-channels")
    p_enrich.add_argument("--limit", type=int, default=None)

    p_serve = sub.add_parser("serve")
    p_serve.add_argument("--port", type=int, default=5001)

    args = parser.parse_args()

    if args.command == "serve":
        from crawler.dev_server import serve

        serve(args.port)
        return

    with get_conn() as conn:
        if args.command == "migrate":
            applied = run_migrations(conn)
            print(f"套用了 {len(applied)} 個 migration:{applied or '(無新項目)'}")

        elif args.command == "seed":
            count = pipeline.seed_from_api(conn, args.api_base, limit=args.limit)
            print(f"已載入 {count} 個種子頻道並排入佇列")

        elif args.command == "add-channel":
            pipeline.add_manual_seed(conn, args.channel_id)
            print(f"已加入種子頻道 {args.channel_id}")

        elif args.command == "run":
            kwargs: dict = {"kinds": args.kinds, "max_tasks": args.max_tasks}
            if args.sleep is not None:
                kwargs["sleep_seconds"] = args.sleep
            processed = pipeline.run_queue(conn, **kwargs)
            print(f"本次處理 {processed} 個任務")

        elif args.command == "enrich-channels":
            from crawler.enrich import enrich_channels
            from crawler.settings import get_youtube_api_key

            updated, missing = enrich_channels(conn, get_youtube_api_key(), limit=args.limit)
            print(f"已補完 {updated} 個頻道,{missing} 個查無資料(已刪除或停權)")

        elif args.command == "expand":
            from crawler.settings import MIN_SUBSCRIBERS

            added = repo.enqueue_missing_list_videos(conn, MIN_SUBSCRIBERS)
            scored = repo.reprioritize_pending_list_videos(conn)
            conn.commit()
            print(f"新排入 {added} 個頻道的 list_videos,重算 {scored} 筆待處理任務的優先權")

        elif args.command == "status":
            print("=== 佇列 ===")
            for kind, status, count in repo.queue_summary(conn):
                print(f"  {kind:22s} {status:8s} {count}")
            print("=== 資料 ===")
            for name, count in repo.data_summary(conn).items():
                print(f"  {name:22s} {count}")


if __name__ == "__main__":
    main()
