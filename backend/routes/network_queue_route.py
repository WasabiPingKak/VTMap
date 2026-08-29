# routes/network_queue_route.py

import logging

from apiflask import APIBlueprint
from flask import jsonify
from google.cloud import firestore

from services.network.queue_service import get_queue_detail
from utils.auth_decorator import require_auth
from utils.jwt_util import is_admin_channel_id


def init_network_queue_route(app, db: firestore.Client):
    bp = APIBlueprint("network_queue", __name__, tag="Network")

    @bp.route("/api/network/admin/queue", methods=["GET"])
    @bp.doc(
        summary="取得爬取佇列明細(管理員)",
        description="回傳關係網路資料蒐集佇列的任務明細與統計",
    )
    @require_auth(db)
    def get_queue(auth_channel_id):
        if not is_admin_channel_id(auth_channel_id):
            logging.warning(f"🚫 非管理員嘗試查看佇列:operator={auth_channel_id}")
            return jsonify({"error": "權限不足"}), 403

        payload = get_queue_detail()
        return jsonify({"success": True, **payload})

    app.register_blueprint(bp)
