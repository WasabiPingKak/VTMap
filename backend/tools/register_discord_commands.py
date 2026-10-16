"""
註冊 Discord 斜線指令 /notify（單一伺服器指令，修改後立即生效）

用法（在 backend/ 下執行）：
    DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... \\
        python tools/register_discord_commands.py

指令內容有修改時重新執行一次即可（PUT 會整批覆蓋）。
"""

import json
import os
import sys

import requests

DISCORD_API_BASE = "https://discord.com/api/v10"

# 選項類型
SUB_COMMAND = 1
STRING = 3
BOOLEAN = 5
CHANNEL = 7
ROLE = 8

# 只有「管理伺服器」權限的成員看得到這個指令
MANAGE_GUILD = str(1 << 5)

TYPE_OPTION = {
    "type": STRING,
    "name": "type",
    "description": "通知類型",
    "required": True,
    "choices": [
        {"name": "直播開台（含首播）", "value": "live"},
        {"name": "影片（長片、Shorts）", "value": "video"},
    ],
}

COMMANDS = [
    {
        "name": "notify",
        "description": "YouTube 開台與新影片通知設定",
        "default_member_permissions": MANAGE_GUILD,
        "dm_permission": False,
        "options": [
            {"type": SUB_COMMAND, "name": "status", "description": "查看目前的通知設定"},
            {
                "type": SUB_COMMAND,
                "name": "channel",
                "description": "設定通知要發到哪個頻道",
                "options": [
                    TYPE_OPTION,
                    {
                        "type": CHANNEL,
                        "name": "channel",
                        "description": "發送通知的頻道",
                        "required": True,
                        "channel_types": [0, 5],
                    },
                ],
            },
            {
                "type": SUB_COMMAND,
                "name": "role",
                "description": "設定通知要 tag 的身分組（不填則不 tag）",
                "options": [
                    TYPE_OPTION,
                    {"type": ROLE, "name": "role", "description": "要 tag 的身分組"},
                ],
            },
            {
                "type": SUB_COMMAND,
                "name": "template",
                "description": "編輯通知訊息模板",
                "options": [TYPE_OPTION],
            },
            {
                "type": SUB_COMMAND,
                "name": "toggle",
                "description": "開啟或關閉通知",
                "options": [
                    TYPE_OPTION,
                    {
                        "type": BOOLEAN,
                        "name": "enabled",
                        "description": "是否開啟",
                        "required": True,
                    },
                ],
            },
            {
                "type": SUB_COMMAND,
                "name": "test",
                "description": "發送一則測試通知",
                "options": [TYPE_OPTION],
            },
        ],
    }
]


def main() -> int:
    app_id = os.getenv("DISCORD_APPLICATION_ID", "")
    token = os.getenv("DISCORD_BOT_TOKEN", "")
    guild_id = os.getenv("DISCORD_GUILD_ID", "")
    if not (app_id and token and guild_id):
        print("❌ 需要設定 DISCORD_APPLICATION_ID、DISCORD_BOT_TOKEN、DISCORD_GUILD_ID")
        return 1

    resp = requests.put(
        f"{DISCORD_API_BASE}/applications/{app_id}/guilds/{guild_id}/commands",
        headers={"Authorization": f"Bot {token}"},
        json=COMMANDS,
        timeout=10,
    )
    if not resp.ok:
        print(f"❌ 註冊失敗：{resp.status_code}\n{resp.text}")
        return 1

    names = [c["name"] for c in resp.json()]
    print(f"✅ 已註冊指令：{json.dumps(names, ensure_ascii=False)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
