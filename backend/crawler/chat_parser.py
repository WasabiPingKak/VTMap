"""解析 yt-dlp 下載的 live_chat.json(JSON Lines),統計每位發言者的 badge。

badge 判定依據 iconType(MODERATOR / OWNER / VERIFIED),不受直播主介面語言影響;
會員 badge 沒有 iconType、只有 customThumbnail。
"""

import json
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

BADGE_MODERATOR = "moderator"
BADGE_OWNER = "owner"
BADGE_MEMBER = "member"


@dataclass
class AuthorStats:
    name: str
    badges: set[str] = field(default_factory=set)
    message_count: int = 0


@dataclass
class ChatStats:
    total_lines: int = 0
    authors: dict[str, AuthorStats] = field(default_factory=dict)

    def authors_with_badge(self, badge: str) -> dict[str, AuthorStats]:
        return {aid: a for aid, a in self.authors.items() if badge in a.badges}


def _find_author_renderers(node: Any) -> Iterator[dict]:
    """遞迴找出所有含 authorExternalChannelId 的 renderer dict。"""
    if isinstance(node, dict):
        if "authorExternalChannelId" in node:
            yield node
        else:
            for value in node.values():
                yield from _find_author_renderers(value)
    elif isinstance(node, list):
        for value in node:
            yield from _find_author_renderers(value)


def _classify_badges(renderer: dict) -> set[str]:
    kinds: set[str] = set()
    for badge in renderer.get("authorBadges") or []:
        badge_renderer = badge.get("liveChatAuthorBadgeRenderer") or {}
        icon_type = (badge_renderer.get("icon") or {}).get("iconType")
        if icon_type == "MODERATOR":
            kinds.add(BADGE_MODERATOR)
        elif icon_type == "OWNER":
            kinds.add(BADGE_OWNER)
        elif icon_type is None and "customThumbnail" in badge_renderer:
            kinds.add(BADGE_MEMBER)
    return kinds


def parse_live_chat_file(path: Path) -> ChatStats:
    stats = ChatStats()
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            stats.total_lines += 1
            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue
            for renderer in _find_author_renderers(data):
                author_id = renderer.get("authorExternalChannelId")
                if not author_id:
                    continue
                name = (renderer.get("authorName") or {}).get("simpleText", "")
                record = stats.authors.setdefault(author_id, AuthorStats(name=name))
                if name and not record.name:
                    record.name = name
                record.message_count += 1
                record.badges |= _classify_badges(renderer)
    return stats
