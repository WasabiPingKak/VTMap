# routes/network_route.py

from apiflask import APIBlueprint
from flask import jsonify, request

from services.network.graph_service import (
    DEFAULT_RECENT_LIMIT,
    get_network_graph,
    get_queue_rank,
    get_recent_nodes,
)


def init_network_route(app):
    bp = APIBlueprint("network_route", __name__, tag="Network")

    @bp.route("/api/network/graph", methods=["GET"])
    @bp.doc(
        summary="取得 VTuber 關係網路圖",
        description="回傳完整關係圖:節點(頻道)與邊(管理員關係,含證據影片清單)",
    )
    def get_graph():
        payload = get_network_graph()
        return jsonify({"success": True, **payload})

    @bp.route("/api/network/recent", methods=["GET"])
    @bp.doc(
        summary="最近加入的頻道",
        description="依 created_at 降冪回傳最近加入圖上的頻道,含訂閱數與掃描狀態",
    )
    def get_recent():
        try:
            limit = int(request.args.get("limit", DEFAULT_RECENT_LIMIT))
        except (TypeError, ValueError):
            limit = DEFAULT_RECENT_LIMIT
        payload = get_recent_nodes(limit)
        return jsonify({"success": True, **payload})

    @bp.route("/api/network/queue-rank/<channel_id>", methods=["GET"])
    @bp.doc(
        summary="頻道在爬蟲佇列的累計順位",
        description="回傳 rank(int)或 null;null 代表沒有 pending task",
    )
    def get_rank(channel_id: str):
        payload = get_queue_rank(channel_id)
        return jsonify({"success": True, **payload})

    app.register_blueprint(bp)
