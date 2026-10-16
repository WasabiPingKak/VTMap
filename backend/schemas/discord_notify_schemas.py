"""Discord 通知設定 API 的 request schema"""

from typing import Literal

from pydantic import BaseModel, Field

from services.discord_notify.config_store import TEMPLATE_MAX_LENGTH

DISCORD_ID_PATTERN = r"^\d{1,20}$"


class UpdateDiscordNotifyRequest(BaseModel):
    """PUT /api/discord-notify/config"""

    kind: Literal["live", "video"]
    enabled: bool
    discord_channel_id: str | None = Field(default=None, pattern=DISCORD_ID_PATTERN)
    role_id: str | None = Field(default=None, pattern=DISCORD_ID_PATTERN)
    template: str = Field(min_length=1, max_length=TEMPLATE_MAX_LENGTH)


class DiscordNotifyTestRequest(BaseModel):
    """POST /api/discord-notify/test"""

    kind: Literal["live", "video"]
