"""crawler.chat_parser 的單元測試(純解析邏輯,不需網路與資料庫)。"""

import json

from crawler.chat_parser import (
    BADGE_MEMBER,
    BADGE_MODERATOR,
    BADGE_OWNER,
    parse_live_chat_file,
)


def _chat_line(author_id: str, name: str, badges: list[dict] | None = None) -> str:
    """組出一行 yt-dlp live_chat.json 格式的聊天訊息。"""
    renderer = {
        "authorExternalChannelId": author_id,
        "authorName": {"simpleText": name},
        "message": {"runs": [{"text": "hi"}]},
    }
    if badges:
        renderer["authorBadges"] = badges
    return json.dumps(
        {
            "replayChatItemAction": {
                "actions": [
                    {"addChatItemAction": {"item": {"liveChatTextMessageRenderer": renderer}}}
                ]
            }
        },
        ensure_ascii=False,
    )


def _mod_badge() -> dict:
    return {"liveChatAuthorBadgeRenderer": {"icon": {"iconType": "MODERATOR"}, "tooltip": "管理員"}}


def _owner_badge() -> dict:
    return {"liveChatAuthorBadgeRenderer": {"icon": {"iconType": "OWNER"}, "tooltip": "擁有者"}}


def _member_badge() -> dict:
    return {
        "liveChatAuthorBadgeRenderer": {
            "customThumbnail": {"thumbnails": [{"url": "https://example.com/badge.png"}]},
            "tooltip": "會員(1 年)",
        }
    }


def test_parse_classifies_badges_by_icon_type(tmp_path):
    chat_file = tmp_path / "chat.live_chat.json"
    chat_file.write_text(
        "\n".join(
            [
                _chat_line("UC_mod", "mod_user", [_mod_badge()]),
                _chat_line("UC_owner", "owner_user", [_owner_badge()]),
                _chat_line("UC_member", "member_user", [_member_badge()]),
                _chat_line("UC_plain", "plain_user"),
            ]
        ),
        encoding="utf-8",
    )

    stats = parse_live_chat_file(chat_file)

    assert stats.total_lines == 4
    assert set(stats.authors) == {"UC_mod", "UC_owner", "UC_member", "UC_plain"}
    assert stats.authors["UC_mod"].badges == {BADGE_MODERATOR}
    assert stats.authors["UC_owner"].badges == {BADGE_OWNER}
    assert stats.authors["UC_member"].badges == {BADGE_MEMBER}
    assert stats.authors["UC_plain"].badges == set()


def test_parse_accumulates_message_counts_and_badges(tmp_path):
    # 同一人多次發言,badge 只出現在部分訊息(YouTube 實務上會這樣)
    chat_file = tmp_path / "chat.live_chat.json"
    chat_file.write_text(
        "\n".join(
            [
                _chat_line("UC_a", "user_a"),
                _chat_line("UC_a", "user_a", [_mod_badge(), _member_badge()]),
                _chat_line("UC_a", "user_a"),
            ]
        ),
        encoding="utf-8",
    )

    stats = parse_live_chat_file(chat_file)

    assert stats.authors["UC_a"].message_count == 3
    assert stats.authors["UC_a"].badges == {BADGE_MODERATOR, BADGE_MEMBER}
    assert stats.authors_with_badge(BADGE_MODERATOR).keys() == {"UC_a"}


def test_parse_skips_blank_and_malformed_lines(tmp_path):
    chat_file = tmp_path / "chat.live_chat.json"
    chat_file.write_text(
        "\n".join(
            [
                "",
                "not json at all",
                _chat_line("UC_x", "user_x", [_mod_badge()]),
                "   ",
            ]
        ),
        encoding="utf-8",
    )

    stats = parse_live_chat_file(chat_file)

    assert set(stats.authors) == {"UC_x"}
    # 空行不計入,壞行計入行數但不產生 author
    assert stats.total_lines == 2
