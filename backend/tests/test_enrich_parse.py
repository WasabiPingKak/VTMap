"""crawler.enrich 的純解析測試(不打 API)。"""

from crawler.enrich import parse_snippets


def test_parse_snippets_extracts_title_handle_thumbnail_subscribers():
    items = [
        {
            "id": "UC_a",
            "snippet": {
                "title": "頻道正式名稱",
                "customUrl": "@handle_a",
                "thumbnails": {
                    "default": {"url": "https://img/default.jpg"},
                    "medium": {"url": "https://img/medium.jpg"},
                    "high": {"url": "https://img/high.jpg"},
                },
            },
            "statistics": {"subscriberCount": "1234", "hiddenSubscriberCount": False},
        }
    ]
    result = parse_snippets(items)
    assert result["UC_a"] == {
        "title": "頻道正式名稱",
        "handle": "@handle_a",
        "thumbnail": "https://img/medium.jpg",  # 優先 medium
        "subscribers": 1234,
    }


def test_parse_snippets_handles_missing_fields():
    items = [
        {"id": "UC_b", "snippet": {"title": "只有名稱"}},
        {"snippet": {"title": "沒有 id,略過"}},
        {"id": "UC_c"},
    ]
    result = parse_snippets(items)
    assert result["UC_b"] == {
        "title": "只有名稱",
        "handle": None,
        "thumbnail": None,
        "subscribers": None,
    }
    assert result["UC_c"]["title"] is None
    assert result["UC_c"]["subscribers"] is None
    assert len(result) == 2


def test_parse_snippets_thumbnail_fallback_order():
    items = [
        {
            "id": "UC_d",
            "snippet": {"thumbnails": {"high": {"url": "https://img/high.jpg"}}},
        }
    ]
    result = parse_snippets(items)
    assert result["UC_d"]["thumbnail"] == "https://img/high.jpg"


def test_parse_snippets_hidden_subscriber_count_is_none():
    items = [
        {
            "id": "UC_e",
            "snippet": {"title": "隱藏訂閱數"},
            "statistics": {"subscriberCount": "999", "hiddenSubscriberCount": True},
        },
        {
            "id": "UC_f",
            "snippet": {"title": "訂閱數非數字"},
            "statistics": {"subscriberCount": "abc"},
        },
    ]
    result = parse_snippets(items)
    assert result["UC_e"]["subscribers"] is None
    assert result["UC_f"]["subscribers"] is None
