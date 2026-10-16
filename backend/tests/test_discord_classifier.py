"""
discord_notify/classifier 測試：依 YouTube 影片資料決定通知動作
"""

from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch

import requests

from services.discord_notify.classifier import (
    ACTION_NOTIFY,
    ACTION_SKIP,
    ACTION_WAIT,
    KIND_LIVE,
    KIND_VIDEO,
    LABEL_LIVE,
    LABEL_PREMIERE,
    LABEL_SHORTS,
    LABEL_VIDEO,
    _is_shorts_url,
    classify_for_notify,
)

NOW = datetime(2026, 10, 17, 12, 0, tzinfo=UTC)


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def make_item(
    *,
    duration="PT10M",
    privacy="public",
    published=NOW - timedelta(minutes=5),
    live=None,
):
    item = {
        "id": "vid1",
        "snippet": {"channelId": "UC1", "title": "t", "publishedAt": _iso(published)},
        "status": {"privacyStatus": privacy},
        "contentDetails": {"duration": duration},
    }
    if live is not None:
        item["liveStreamingDetails"] = live
    return item


class TestRegularUpload:
    def test_long_video(self):
        d = classify_for_notify(make_item(duration="PT10M"), NOW)
        assert (d.action, d.kind, d.label) == (ACTION_NOTIFY, KIND_VIDEO, LABEL_VIDEO)

    @patch("services.discord_notify.classifier._is_shorts_url", return_value=True)
    def test_shorts_confirmed_by_url(self, _mock):
        d = classify_for_notify(make_item(duration="PT2M30S"), NOW)
        assert d.label == LABEL_SHORTS

    @patch("services.discord_notify.classifier._is_shorts_url", return_value=False)
    def test_short_duration_but_not_shorts(self, _mock):
        d = classify_for_notify(make_item(duration="PT2M"), NOW)
        assert d.label == LABEL_VIDEO

    @patch("services.discord_notify.classifier._is_shorts_url", return_value=None)
    def test_shorts_check_failed_falls_back_to_duration(self, _mock):
        d = classify_for_notify(make_item(duration="PT45S"), NOW)
        assert d.label == LABEL_SHORTS

    def test_old_video_skipped(self):
        """改標題等操作會觸發舊片的推播，不應通知"""
        d = classify_for_notify(make_item(published=NOW - timedelta(days=3)), NOW)
        assert d.action == ACTION_SKIP

    def test_private_video_skipped(self):
        d = classify_for_notify(make_item(privacy="private"), NOW)
        assert d.action == ACTION_SKIP


class TestLiveAndPremiere:
    def test_upcoming_stream_waits(self):
        sched = _iso(NOW + timedelta(hours=3))
        d = classify_for_notify(make_item(duration="P0D", live={"scheduledStartTime": sched}), NOW)
        assert d.action == ACTION_WAIT
        assert d.scheduled_start == sched

    def test_upcoming_premiere_waits(self):
        sched = _iso(NOW + timedelta(hours=1))
        d = classify_for_notify(make_item(duration="PT8M", live={"scheduledStartTime": sched}), NOW)
        assert d.action == ACTION_WAIT

    def test_live_started(self):
        live = {"actualStartTime": _iso(NOW - timedelta(minutes=1))}
        d = classify_for_notify(make_item(duration="P0D", live=live), NOW)
        assert (d.action, d.kind, d.label) == (ACTION_NOTIFY, KIND_LIVE, LABEL_LIVE)

    def test_premiere_started_counts_as_video(self):
        live = {"actualStartTime": _iso(NOW - timedelta(minutes=1))}
        d = classify_for_notify(make_item(duration="PT8M", live=live), NOW)
        assert (d.action, d.kind, d.label) == (ACTION_NOTIFY, KIND_VIDEO, LABEL_PREMIERE)

    def test_live_started_long_ago_skipped(self):
        live = {"actualStartTime": _iso(NOW - timedelta(hours=5))}
        d = classify_for_notify(make_item(duration="P0D", live=live), NOW)
        assert d.action == ACTION_SKIP

    def test_ended_stream_skipped(self):
        live = {
            "actualStartTime": _iso(NOW - timedelta(hours=2)),
            "actualEndTime": _iso(NOW - timedelta(minutes=1)),
        }
        d = classify_for_notify(make_item(duration="PT2H", live=live), NOW)
        assert d.action == ACTION_SKIP

    def test_ended_premiere_still_notifies(self):
        """首播很短，推播晚到時可能已經結束，仍算新影片"""
        start = NOW - timedelta(minutes=10)
        live = {"actualStartTime": _iso(start), "actualEndTime": _iso(NOW - timedelta(minutes=2))}
        item = make_item(duration="PT8M", live=live, published=start + timedelta(seconds=30))
        d = classify_for_notify(item, NOW)
        assert (d.action, d.kind, d.label) == (ACTION_NOTIFY, KIND_VIDEO, LABEL_PREMIERE)


class TestIsShortsUrl:
    @patch("services.discord_notify.classifier.requests.head")
    def test_200_is_shorts(self, mock_head):
        mock_head.return_value = MagicMock(status_code=200)
        assert _is_shorts_url("vid1") is True
        assert mock_head.call_args.kwargs["allow_redirects"] is False

    @patch("services.discord_notify.classifier.requests.head")
    def test_redirect_is_not_shorts(self, mock_head):
        mock_head.return_value = MagicMock(status_code=303)
        assert _is_shorts_url("vid1") is False

    @patch("services.discord_notify.classifier.requests.head")
    def test_request_error_returns_none(self, mock_head):
        mock_head.side_effect = requests.ConnectionError("boom")
        assert _is_shorts_url("vid1") is None
