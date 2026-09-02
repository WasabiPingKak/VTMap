"""爬蟲管理 UI 的本機 server。

啟動後在 http://127.0.0.1:5002 提供單頁 UI:
  - 顯示佇列與資料統計、爬蟲 process 狀態
  - Start / Stop / Restart 爬蟲 run
  - 觸發一次性的 enrich-channels / expand
  - 手動加入種子頻道、重排 list_videos、重試所有 failed 任務
  - Tail 最後 N 行 log

Python 3.10 相容,沿用 stdlib http.server(這台機器跑不動 Flask)。
"""

import atexit
import json
import logging
import os
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from crawler import repo
from crawler.db import get_conn

logger = logging.getLogger(__name__)

BACKEND_DIR = Path(__file__).resolve().parents[1]
ADMIN_HTML = Path(__file__).resolve().parent / "admin.html"
QUEUE_HTML = Path(__file__).resolve().parent / "queue.html"
LOG_FILE = BACKEND_DIR / "crawler-run.log"

_ACTIVE_TASKS_SQL = """
select q.id, q.kind, q.status, q.priority, q.attempts, q.channel_id, q.video_id,
       q.last_error, q.created_at, q.updated_at,
       c.title, c.handle, c.thumbnail_url
from crawl_queue q
left join channels c on c.channel_id = q.channel_id
where q.status in ('pending', 'running', 'failed')
order by case q.status when 'running' then 0 when 'pending' then 1 else 2 end,
         q.priority desc, q.id
limit 500
"""

_RECENT_DONE_SQL = """
select q.id, q.kind, q.channel_id, q.video_id, q.updated_at, c.title, c.handle
from crawl_queue q
left join channels c on c.channel_id = q.channel_id
where q.status = 'done'
order by q.updated_at desc
limit 20
"""

_VALID_KINDS = {"run", "enrich-channels", "expand"}


class _Supervisor:
    """管一個 crawler subprocess,同時間只能一個。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._proc: subprocess.Popen | None = None
        self._kind: str | None = None
        self._started_at: datetime | None = None

    def start(self, kind: str) -> tuple[bool, str]:
        if kind not in _VALID_KINDS:
            return False, f"未知的類型:{kind}"
        with self._lock:
            if self._proc is not None and self._proc.poll() is None:
                return False, f"已經有一個 {self._kind} 在跑,請先停止"
            log_fh = open(LOG_FILE, "a", encoding="utf-8", buffering=1)
            log_fh.write(
                f"\n===== {datetime.now().isoformat(timespec='seconds')} start {kind} =====\n"
            )
            log_fh.flush()
            self._proc = subprocess.Popen(
                [sys.executable, "-X", "utf8", "-m", "crawler", kind],
                cwd=str(BACKEND_DIR),
                stdout=log_fh,
                stderr=subprocess.STDOUT,
                env=os.environ.copy(),
            )
            self._kind = kind
            self._started_at = datetime.now(timezone.utc)
            logger.info("已啟動 crawler %s (PID=%s)", kind, self._proc.pid)
            return True, f"已啟動 {kind}"

    def stop(self) -> tuple[bool, str]:
        with self._lock:
            proc = self._proc
            if proc is None or proc.poll() is not None:
                self._proc = None
                self._kind = None
                self._started_at = None
                return False, "目前沒有在跑"
            proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
        with self._lock:
            kind = self._kind
            self._proc = None
            self._kind = None
            self._started_at = None
        return True, f"已停止 {kind}"

    def status(self) -> dict:
        with self._lock:
            proc = self._proc
            kind = self._kind
            started_at = self._started_at
            if proc is None:
                return {"status": "stopped", "kind": None, "pid": None, "started_at": None}
            rc = proc.poll()
            if rc is not None:
                # 自然結束,清狀態但保留最後一次資訊
                self._proc = None
                self._kind = None
                self._started_at = None
                return {
                    "status": "exited",
                    "kind": kind,
                    "pid": proc.pid,
                    "started_at": started_at.isoformat() if started_at else None,
                    "return_code": rc,
                }
            return {
                "status": "running",
                "kind": kind,
                "pid": proc.pid,
                "started_at": started_at.isoformat() if started_at else None,
            }


_supervisor = _Supervisor()


def _cleanup_on_exit() -> None:
    _supervisor.stop()


atexit.register(_cleanup_on_exit)


def _read_log_tail(lines: int) -> str:
    """讀 log 檔尾巴 N 行。檔案不存在或沒內容時回空字串。"""
    if not LOG_FILE.exists():
        return ""
    max_bytes = max(4096, lines * 400)
    size = LOG_FILE.stat().st_size
    with LOG_FILE.open("rb") as f:
        if size > max_bytes:
            f.seek(size - max_bytes)
            # 丟掉開頭殘缺的一行
            f.readline()
        data = f.read()
    text = data.decode("utf-8", errors="replace")
    return "\n".join(text.splitlines()[-lines:])


def _json_response(handler: BaseHTTPRequestHandler, code: int, payload: dict | list) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _text_response(
    handler: BaseHTTPRequestHandler,
    code: int,
    body: bytes,
    content_type: str,
) -> None:
    handler.send_response(code)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _read_json_body(handler: BaseHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("Content-Length") or 0)
    if length <= 0:
        return {}
    raw = handler.rfile.read(length)
    if not raw:
        return {}
    try:
        return json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError:
        return {}


def _handle_status(handler: BaseHTTPRequestHandler) -> None:
    proc = _supervisor.status()
    try:
        with get_conn() as conn:
            queue = [{"kind": k, "status": s, "count": c} for k, s, c in repo.queue_summary(conn)]
            data = repo.data_summary(conn)
    except Exception as e:
        _json_response(handler, 500, {"success": False, "error": str(e)})
        return
    _json_response(
        handler,
        200,
        {
            "success": True,
            "crawler": proc,
            "queue": queue,
            "data": data,
            "server_time": datetime.now(timezone.utc).isoformat(),
        },
    )


def _handle_log_tail(handler: BaseHTTPRequestHandler, query: str) -> None:
    lines = 200
    for part in query.split("&") if query else []:
        if part.startswith("lines="):
            try:
                lines = max(1, min(2000, int(part.split("=", 1)[1])))
            except ValueError:
                pass
    body = _read_log_tail(lines).encode("utf-8")
    _text_response(handler, 200, body, "text/plain; charset=utf-8")


def _handle_start(handler: BaseHTTPRequestHandler, kind: str) -> None:
    ok, msg = _supervisor.start(kind)
    _json_response(handler, 200 if ok else 409, {"success": ok, "message": msg})


def _handle_stop(handler: BaseHTTPRequestHandler) -> None:
    ok, msg = _supervisor.stop()
    _json_response(handler, 200, {"success": ok, "message": msg})


def _handle_restart(handler: BaseHTTPRequestHandler) -> None:
    _supervisor.stop()
    ok, msg = _supervisor.start("run")
    _json_response(handler, 200 if ok else 500, {"success": ok, "message": msg})


def _handle_enqueue_channel(handler: BaseHTTPRequestHandler) -> None:
    body = _read_json_body(handler)
    channel_id = (body.get("channel_id") or "").strip()
    if not channel_id:
        _json_response(handler, 400, {"success": False, "error": "缺少 channel_id"})
        return
    try:
        with get_conn() as conn:
            from crawler import pipeline

            pipeline.add_manual_seed(conn, channel_id)
    except Exception as e:
        _json_response(handler, 500, {"success": False, "error": str(e)})
        return
    _json_response(handler, 200, {"success": True, "message": f"已加入種子 {channel_id}"})


def _handle_enqueue_list_videos(handler: BaseHTTPRequestHandler) -> None:
    body = _read_json_body(handler)
    channel_id = (body.get("channel_id") or "").strip()
    if not channel_id:
        _json_response(handler, 400, {"success": False, "error": "缺少 channel_id"})
        return
    try:
        with get_conn() as conn:
            count = repo.requeue_list_videos_for_channel(conn, channel_id)
            conn.commit()
    except Exception as e:
        _json_response(handler, 500, {"success": False, "error": str(e)})
        return
    if count == 0:
        _json_response(
            handler,
            200,
            {"success": True, "message": f"{channel_id} 沒有可重抓的影片列表"},
        )
        return
    _json_response(
        handler,
        200,
        {"success": True, "message": f"已排定重抓 {channel_id} 的影片列表({count} 筆)"},
    )


def _handle_retry_failed(handler: BaseHTTPRequestHandler) -> None:
    try:
        with get_conn() as conn:
            count = repo.retry_failed_tasks(conn)
            conn.commit()
    except Exception as e:
        _json_response(handler, 500, {"success": False, "error": str(e)})
        return
    _json_response(handler, 200, {"success": True, "message": f"已把 {count} 個失敗任務改回待處理"})


def _handle_index(handler: BaseHTTPRequestHandler) -> None:
    try:
        body = ADMIN_HTML.read_bytes()
    except FileNotFoundError:
        _text_response(handler, 500, b"admin.html not found", "text/plain")
        return
    _text_response(handler, 200, body, "text/html; charset=utf-8")


def _handle_queue_page(handler: BaseHTTPRequestHandler) -> None:
    try:
        body = QUEUE_HTML.read_bytes()
    except FileNotFoundError:
        _text_response(handler, 500, b"queue.html not found", "text/plain")
        return
    _text_response(handler, 200, body, "text/html; charset=utf-8")


def _iso(value: object) -> str | None:
    return value.isoformat() if isinstance(value, datetime) else None


def _handle_queue_data(handler: BaseHTTPRequestHandler) -> None:
    try:
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(_ACTIVE_TASKS_SQL)
            tasks = [
                {
                    "id": r[0],
                    "kind": r[1],
                    "status": r[2],
                    "priority": r[3],
                    "attempts": r[4],
                    "channel_id": r[5],
                    "video_id": r[6],
                    "last_error": r[7],
                    "created_at": _iso(r[8]),
                    "updated_at": _iso(r[9]),
                    "channel_title": r[10],
                    "channel_handle": r[11],
                    "channel_thumbnail": r[12],
                }
                for r in cur.fetchall()
            ]
            cur.execute(_RECENT_DONE_SQL)
            recent_done = [
                {
                    "id": r[0],
                    "kind": r[1],
                    "channel_id": r[2],
                    "video_id": r[3],
                    "updated_at": _iso(r[4]),
                    "channel_title": r[5],
                    "channel_handle": r[6],
                }
                for r in cur.fetchall()
            ]
    except Exception as e:
        _json_response(handler, 500, {"success": False, "error": str(e)})
        return
    _json_response(
        handler,
        200,
        {
            "success": True,
            "tasks": tasks,
            "recent_done": recent_done,
            "server_time": datetime.now(timezone.utc).isoformat(),
        },
    )


_GET_ROUTES = {
    "/": _handle_index,
    "/queue": _handle_queue_page,
    "/api/admin/status": _handle_status,
    "/api/admin/queue": _handle_queue_data,
}

_POST_ROUTES = {
    "/api/admin/run/start": lambda h: _handle_start(h, "run"),
    "/api/admin/run/stop": _handle_stop,
    "/api/admin/run/restart": _handle_restart,
    "/api/admin/enrich": lambda h: _handle_start(h, "enrich-channels"),
    "/api/admin/expand": lambda h: _handle_start(h, "expand"),
    "/api/admin/enqueue/channel": _handle_enqueue_channel,
    "/api/admin/enqueue/list_videos": _handle_enqueue_list_videos,
    "/api/admin/retry_failed": _handle_retry_failed,
}


class _AdminHandler(BaseHTTPRequestHandler):
    server_version = "CrawlerAdmin/1.0"

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/admin/log/tail":
            _handle_log_tail(self, parsed.query)
            return
        handler = _GET_ROUTES.get(path)
        if handler is None:
            _text_response(self, 404, b"not found", "text/plain")
            return
        try:
            handler(self)
        except Exception as e:
            logger.exception("handler 錯誤")
            _json_response(self, 500, {"success": False, "error": str(e)})

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        handler = _POST_ROUTES.get(parsed.path)
        if handler is None:
            _text_response(self, 404, b"not found", "text/plain")
            return
        try:
            handler(self)
        except Exception as e:
            logger.exception("handler 錯誤")
            _json_response(self, 500, {"success": False, "error": str(e)})

    def log_message(self, fmt: str, *args: object) -> None:
        # 減少雜訊,只印非 200 的
        if args and str(args[1]).startswith("2"):
            return
        logger.info("%s " + fmt, self.client_address[0], *args)


def serve(port: int) -> None:
    server = ThreadingHTTPServer(("127.0.0.1", port), _AdminHandler)
    server.daemon_threads = True
    url = f"http://127.0.0.1:{port}/"
    print(f"Crawler Admin: {url}  (Ctrl+C 結束,關閉時會一併停止爬蟲)")
    print(f"Log 檔:{LOG_FILE}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n收到中止訊號,正在停止爬蟲...")
    finally:
        _supervisor.stop()
        server.server_close()
        # 讓子 process 確認已收攤
        time.sleep(0.2)
