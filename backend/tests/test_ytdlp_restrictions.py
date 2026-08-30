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


def test_classify_download_error_returns_none_for_transient_error():
    stderr = "ERROR: [youtube] abc123: HTTP Error 503: Service Unavailable"

    assert ytdlp.classify_download_error(stderr) is None


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
