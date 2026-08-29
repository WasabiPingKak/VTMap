"""本機前端開發用的迷你 API server。

這台機器的 Python 3.10 跑不動 Flask 後端(需 3.12),前端開發時用這個
stdlib server 提供 /api/network/graph,回應格式與正式 API 相同。
僅限本機開發使用,不部署。
"""

import json
import logging
from http.server import BaseHTTPRequestHandler, HTTPServer

from crawler.db import get_conn
from services.network.graph_query import fetch_graph_payload

logger = logging.getLogger(__name__)


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 — http.server 介面命名
        if self.path.split("?")[0] != "/api/network/graph":
            self.send_error(404)
            return
        try:
            with get_conn() as conn:
                payload = fetch_graph_payload(conn)
        except Exception as e:
            logger.error("查詢失敗:%s", e)
            self.send_error(500, str(e))
            return

        body = json.dumps({"success": True, **payload}, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args: object) -> None:
        logger.info("%s " + fmt, self.client_address[0], *args)


def serve(port: int) -> None:
    server = HTTPServer(("127.0.0.1", port), _Handler)
    print(f"dev API server: http://127.0.0.1:{port}/api/network/graph(Ctrl+C 結束)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
