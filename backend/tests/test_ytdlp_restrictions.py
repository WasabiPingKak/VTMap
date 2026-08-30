"""crawler.ytdlp 的受限制影片判斷測試。"""

from pathlib import Path
from subprocess import CompletedProcess

from crawler import ytdlp


def test_classify_download_error_detects_members_only():
    stderr = (
        "ERROR: [youtube] abc123: Join this channel to get access to "
        "members-only content like this video, and other exclusive perks."
    )

    assert ytdlp.classify_download_error(stderr) == "members_only"


def test_classify_download_error_detects_member_level_message():
    stderr = (
        "ERROR: [youtube] abc123: This video is available to this channel's "
        "members on level: 大瓶裝血包 (or any higher level)."
    )

    assert ytdlp.classify_download_error(stderr) == "members_only"


def test_classify_download_error_detects_age_restricted():
    stderr = "ERROR: [youtube] abc123: Sign in to confirm your age."

    assert ytdlp.classify_download_error(stderr) == "age_restricted"


def test_classify_download_error_detects_not_available():
    stderr = "ERROR: [youtube] abc123: This video is not available"

    assert ytdlp.classify_download_error(stderr) == "video_unavailable"


def test_classify_download_error_returns_none_for_transient_error():
    stderr = "ERROR: [youtube] abc123: HTTP Error 503: Service Unavailable"

    assert ytdlp.classify_download_error(stderr) is None


def _fake_streams_listing(monkeypatch, stdout):
    def fake_run(cmd, *args, **kwargs):
        fake_run.cmd = cmd
        return CompletedProcess(args=[], returncode=0, stdout=stdout, stderr="")

    monkeypatch.setattr(ytdlp.subprocess, "run", fake_run)
    return fake_run


def test_list_recent_streams_skips_members_only_and_backfills(monkeypatch):
    """會員限定與預定直播不佔回溯額度,往後補到滿。"""
    _fake_streams_listing(
        monkeypatch,
        "\n".join(
            [
                "v0\tis_upcoming\tNA\t預定直播",
                "v1\twas_live\tsubscriber_only\t會員限定",
                "v2\twas_live\tNA\t公開一",
                "v3\twas_live\tsubscriber_only\t會員限定",
                "v4\twas_live\tNA\t公開二",
                "v5\twas_live\tNA\t公開三",
            ]
        ),
    )

    entries = ytdlp.list_recent_streams("UCtest", 3)

    assert [e.video_id for e in entries] == ["v2", "v4", "v5"]


def test_list_recent_streams_scans_wider_than_limit(monkeypatch):
    fake_run = _fake_streams_listing(monkeypatch, "v1\twas_live\tNA\t公開")

    ytdlp.list_recent_streams("UCtest", 10)

    end_index = fake_run.cmd.index("--playlist-end")
    assert int(fake_run.cmd[end_index + 1]) == 10 * ytdlp.LIST_SCAN_MULTIPLIER


def test_download_live_chat_returns_skip_status_for_members_only(monkeypatch, tmp_path):
    def fake_run(*args, **kwargs):
        return CompletedProcess(
            args=[],
            returncode=1,
            stderr="ERROR: [youtube] abc123: Join this channel to get access to members-only content",
        )

    monkeypatch.setattr(ytdlp.subprocess, "run", fake_run)

    result = ytdlp.download_live_chat("abc123", Path(tmp_path))

    assert result.chat_path is None
    assert result.skip_status == "members_only"
