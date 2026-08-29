# routes/network_route.py

from apiflask import APIBlueprint
from flask import jsonify

from services.network.graph_service import get_network_graph


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

    app.register_blueprint(bp)
