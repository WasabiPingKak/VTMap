"""
discord_notify/config_store 測試：設定讀寫、開關快取、訊息模板渲染
"""

from unittest.mock import patch

from services.discord_notify.config_store import (
    DEFAULT_TEMPLATES,
    find_config_by_guild,
    get_config,
    is_notify_enabled,
    render_message,
    update_kind_config,
)

GUILD = "111"
CONTEXT = {"title": "新影片", "url": "https://y.tb/x", "channel": "冰角", "type": "影片"}


class TestRenderMessage:
    def test_replaces_placeholders(self):
        kc = {"role_id": None, "template": "{channel}：{title} {url}（{type}）"}
        content, mentions = render_message(kc, GUILD, CONTEXT)
        assert content == "冰角：新影片 https://y.tb/x（影片）"
        assert mentions == {"parse": []}

    def test_role_mention_allows_only_that_role(self):
        kc = {"role_id": "222", "template": "{role} 開台 {url}"}
        content, mentions = render_message(kc, GUILD, CONTEXT)
        assert content == "<@&222> 開台 https://y.tb/x"
        assert mentions == {"parse": [], "roles": ["222"]}

    def test_everyone_role_uses_everyone_text(self):
        """@everyone 身分組的 id 等於伺服器 id"""
        kc = {"role_id": GUILD, "template": "{role} 開台"}
        content, mentions = render_message(kc, GUILD, CONTEXT)
        assert content == "@everyone 開台"
        assert mentions == {"parse": ["everyone"]}

    def test_role_prepended_when_template_has_no_placeholder(self):
        kc = {"role_id": "222", "template": "開台 {url}"}
        content, _ = render_message(kc, GUILD, CONTEXT)
        assert content.startswith("<@&222> ")

    def test_no_role_strips_leading_space(self):
        kc = {"role_id": None, "template": DEFAULT_TEMPLATES["live"]}
        content, _ = render_message(kc, GUILD, CONTEXT)
        assert content.startswith("冰角 開台了")

    def test_placeholder_inside_title_not_expanded(self):
        kc = {"role_id": "222", "template": "{title}"}
        content, _ = render_message(kc, GUILD, {**CONTEXT, "title": "{role}{url}"})
        assert content == "<@&222> {role}{url}"


class TestConfigPersistence:
    @patch.dict("os.environ", {"DISCORD_GUILD_ID": GUILD})
    def test_defaults_when_missing(self, db):
        config = get_config(db, "UC1")
        assert config["guild_id"] == GUILD
        assert config["live"]["enabled"] is False
        assert config["video"]["template"] == DEFAULT_TEMPLATES["video"]

    @patch.dict("os.environ", {"DISCORD_GUILD_ID": GUILD})
    def test_update_merges_and_binds_guild(self, db):
        update_kind_config(db, "UC1", "live", {"enabled": True, "discord_channel_id": "9"})
        update_kind_config(db, "UC1", "video", {"role_id": "8"})

        config = get_config(db, "UC1")
        assert config["live"]["enabled"] is True
        assert config["live"]["discord_channel_id"] == "9"
        assert config["video"]["role_id"] == "8"
        assert find_config_by_guild(db, GUILD)["youtube_channel_id"] == "UC1"

    def test_find_by_unknown_guild(self, db):
        assert find_config_by_guild(db, "999") is None

    @patch.dict("os.environ", {"DISCORD_GUILD_ID": GUILD})
    def test_is_notify_enabled_requires_channel(self, db):
        update_kind_config(db, "UC1", "live", {"enabled": True})
        assert is_notify_enabled(db, "UC1") is False

        update_kind_config(db, "UC1", "live", {"discord_channel_id": "9"})
        assert is_notify_enabled(db, "UC1") is True
