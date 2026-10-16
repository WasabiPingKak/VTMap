"""
discord_notify/processor 測試：佇列消化、待機室追蹤、去重、失敗重試

Firestore 用 emulator，YouTube 查詢與 Discord 發送用 mock。
"""

from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest

from services.discord_notify.config_store import update_kind_config
from services.discord_notify.processor import (
    MAX_ATTEMPTS,
    PENDING_COLLECTION,
    QUEUE_COLLECTION,
    SENT_COLLECTION,
    enqueue_video,
    run_tick,
    send_test_message,
)
from utils.exceptions import ExternalServiceError

NOW = datetime(2026, 10, 17, 12, 0, tzinfo=UTC)
CHANNEL = "UC_ADMIN_001"
GUILD = "111"


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def video_item(video_id="vid1", *, duration="PT10M", live=None):
    item = {
        "id": video_id,
        "snippet": {
            "channelId": CHANNEL,
            "channelTitle": "冰角",
            "title": "標題",
            "publishedAt": _iso(NOW - timedelta(minutes=3)),
        },
        "status": {"privacyStatus": "public"},
        "contentDetails": {"duration": duration},
    }
    if live is not None:
        item["liveStreamingDetails"] = live
    return item


@pytest.fixture
def configured(db, monkeypatch):
    monkeypatch.setenv("DISCORD_GUILD_ID", GUILD)
    for kind, channel in (("live", "LIVE_CH"), ("video", "VIDEO_CH")):
        update_kind_config(
            db, CHANNEL, kind, {"enabled": True, "discord_channel_id": channel, "role_id": "7"}
        )
    return db


@pytest.fixture
def mock_fetch():
    with patch("services.discord_notify.processor.batch_fetch_video_details") as m:
        yield m


@pytest.fixture
def mock_send():
    with patch("services.discord_notify.processor.send_message", return_value="msg1") as m:
        yield m


def _exists(db, collection, doc_id):
    return db.collection(collection).document(doc_id).get().exists


class TestTick:
    def test_empty_tick_does_not_call_youtube(self, configured, mock_fetch, mock_send):
        stats = run_tick(configured, NOW)
        assert stats["checked"] == 0
        mock_fetch.assert_not_called()

    def test_new_video_sent_to_video_channel(self, configured, mock_fetch, mock_send):
        enqueue_video(configured, "vid1", CHANNEL, NOW)
        mock_fetch.return_value = [video_item()]

        stats = run_tick(configured, NOW)

        assert stats["sent"] == 1
        channel_id, content, mentions = mock_send.call_args.args
        assert channel_id == "VIDEO_CH"
        assert "<@&7>" in content and "watch?v=vid1" in content
        assert mentions == {"parse": [], "roles": ["7"]}
        assert not _exists(configured, QUEUE_COLLECTION, "vid1")
        sent = configured.collection(SENT_COLLECTION).document("vid1").get().to_dict()
        assert sent["messageId"] == "msg1"

    def test_batches_all_ids_in_one_query(self, configured, mock_fetch, mock_send):
        for vid in ("a", "b", "c"):
            enqueue_video(configured, vid, CHANNEL, NOW)
        mock_fetch.return_value = [video_item(v) for v in ("a", "b", "c")]

        run_tick(configured, NOW)

        assert mock_fetch.call_count == 1
        assert sorted(mock_fetch.call_args.args[0]) == ["a", "b", "c"]

    def test_duplicate_push_not_sent_twice(self, configured, mock_fetch, mock_send):
        mock_fetch.return_value = [video_item()]
        enqueue_video(configured, "vid1", CHANNEL, NOW)
        run_tick(configured, NOW)
        enqueue_video(configured, "vid1", CHANNEL, NOW)
        run_tick(configured, NOW)

        assert mock_send.call_count == 1

    def test_disabled_kind_not_sent(self, configured, mock_fetch, mock_send):
        update_kind_config(configured, CHANNEL, "video", {"enabled": False})
        enqueue_video(configured, "vid1", CHANNEL, NOW)
        mock_fetch.return_value = [video_item()]

        run_tick(configured, NOW)

        mock_send.assert_not_called()
        assert not _exists(configured, QUEUE_COLLECTION, "vid1")

    def test_youtube_failure_keeps_queue(self, configured, mock_fetch, mock_send):
        enqueue_video(configured, "vid1", CHANNEL, NOW)
        mock_fetch.return_value = []

        run_tick(configured, NOW)

        assert _exists(configured, QUEUE_COLLECTION, "vid1")

    def test_deleted_video_removed_from_queue(self, configured, mock_fetch, mock_send):
        enqueue_video(configured, "gone", CHANNEL, NOW)
        enqueue_video(configured, "vid1", CHANNEL, NOW)
        mock_fetch.return_value = [video_item("vid1")]

        run_tick(configured, NOW)

        assert not _exists(configured, QUEUE_COLLECTION, "gone")


class TestWaitingRoom:
    def test_upcoming_moves_to_pending_then_notifies_on_start(
        self, configured, mock_fetch, mock_send
    ):
        sched = NOW + timedelta(hours=2)
        enqueue_video(configured, "live1", CHANNEL, NOW)
        mock_fetch.return_value = [
            video_item("live1", duration="P0D", live={"scheduledStartTime": _iso(sched)})
        ]

        stats = run_tick(configured, NOW)
        assert stats["waiting"] == 1
        assert _exists(configured, PENDING_COLLECTION, "live1")
        assert not _exists(configured, QUEUE_COLLECTION, "live1")
        mock_send.assert_not_called()

        # 預定時間還很久，不會被查
        mock_fetch.reset_mock()
        run_tick(configured, NOW + timedelta(minutes=30))
        mock_fetch.assert_not_called()

        # 接近預定時間且已開台
        later = sched + timedelta(minutes=1)
        mock_fetch.return_value = [
            video_item("live1", duration="P0D", live={"actualStartTime": _iso(sched)})
        ]
        stats = run_tick(configured, later)

        assert stats["sent"] == 1
        assert mock_send.call_args.args[0] == "LIVE_CH"
        assert not _exists(configured, PENDING_COLLECTION, "live1")

    def test_premiere_start_goes_to_video_channel(self, configured, mock_fetch, mock_send):
        configured.collection(PENDING_COLLECTION).document("p1").set(
            {"channelId": CHANNEL, "scheduledStart": NOW}
        )
        mock_fetch.return_value = [
            video_item("p1", duration="PT8M", live={"actualStartTime": _iso(NOW)})
        ]

        run_tick(configured, NOW + timedelta(minutes=1))

        assert mock_send.call_args.args[0] == "VIDEO_CH"
        assert "首播" in mock_send.call_args.args[1]

    def test_abandoned_waiting_room_expires(self, configured, mock_fetch, mock_send):
        sched = NOW - timedelta(hours=7)
        configured.collection(PENDING_COLLECTION).document("old").set(
            {"channelId": CHANNEL, "scheduledStart": sched}
        )
        mock_fetch.return_value = [
            video_item("old", duration="P0D", live={"scheduledStartTime": _iso(sched)})
        ]

        run_tick(configured, NOW)

        assert not _exists(configured, PENDING_COLLECTION, "old")


class TestSendFailure:
    def test_failure_releases_dedup_and_retries(self, configured, mock_fetch, mock_send):
        enqueue_video(configured, "vid1", CHANNEL, NOW)
        mock_fetch.return_value = [video_item()]
        mock_send.side_effect = ExternalServiceError("down")

        run_tick(configured, NOW)

        assert not _exists(configured, SENT_COLLECTION, "vid1")
        queue = configured.collection(QUEUE_COLLECTION).document("vid1").get().to_dict()
        assert queue["attempts"] == 1

        mock_send.side_effect = None
        run_tick(configured, NOW)
        assert _exists(configured, SENT_COLLECTION, "vid1")

    def test_gives_up_after_max_attempts(self, configured, mock_fetch, mock_send):
        enqueue_video(configured, "vid1", CHANNEL, NOW)
        mock_fetch.return_value = [video_item()]
        mock_send.side_effect = ExternalServiceError("down")

        for _ in range(MAX_ATTEMPTS):
            run_tick(configured, NOW)

        assert not _exists(configured, QUEUE_COLLECTION, "vid1")


class TestSendTestMessage:
    def test_marks_message_as_test_and_does_not_ping(self, configured, mock_send):
        send_test_message(configured, CHANNEL, "live")

        channel_id, content, mentions = mock_send.call_args.args
        assert channel_id == "LIVE_CH"
        assert content.startswith("🔧 **這是測試訊息**")
        assert "並沒有真的開台" in content
        assert "（範例標題）" in content
        # 有設定身分組時只顯示文字，不實際提醒
        assert "<@&7>" in content
        assert mentions == {"parse": []}

    def test_video_notice(self, configured, mock_send):
        send_test_message(configured, CHANNEL, "video")

        assert "並沒有發布新影片" in mock_send.call_args.args[1]
