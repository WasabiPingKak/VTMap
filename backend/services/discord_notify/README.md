# Discord 開台與新影片通知

架構與決策見 [`docs/adr/011-discord-notify-http-only.md`](../../../docs/adr/011-discord-notify-http-only.md)。

## 模組

| 檔案 | 用途 |
|---|---|
| `classifier.py` | 依 `videos.list` 結果決定動作（通知 / 等開台 / 略過） |
| `processor.py` | tick 主流程、去重、失敗重試、測試訊息 |
| `config_store.py` | 設定讀寫、訊息模板渲染 |
| `discord_api.py` | Discord REST API |
| `interactions.py` | 斜線指令驗簽與處理 |

## 首次設定

### 1. Discord Developer Portal
1. https://discord.com/developers/applications → **New Application**
2. **General Information**：記下 `Application ID`、`Public Key`
3. **Bot**：**Reset Token** 取得 Bot Token，關閉 **Public Bot**。Privileged Gateway Intents 全部不用開
4. **OAuth2 → URL Generator**：scope 勾 `bot`、`applications.commands`，
   權限勾 `View Channels`、`Send Messages`、`Embed Links`、`Mention Everyone`，用產生的網址邀請進伺服器
5. Discord 開啟開發者模式，右鍵伺服器 → 複製伺服器 ID

### 2. 部署用的設定值（部署前要先建立，否則部署會失敗）

Bot Token 是機密，放 Secret Manager。公開金鑰與伺服器 ID 不是機密，放 GitHub repository variables。
staging 與 production 共用同一個 Bot，所以名稱不加環境前綴。

```bash
P=vtuber-channel-analyzer-v3
gcloud secrets create discord-bot-token --project $P --data-file=-   # 貼上 Token 後 Ctrl+D
# 這個專案是逐個 secret 授權，service account 的 roles/editor 讀不到 secret 內容
gcloud secrets add-iam-policy-binding discord-bot-token --project $P \
  --member="serviceAccount:309119867924-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

gh variable set DISCORD_PUBLIC_KEY --body '<公開金鑰>'
gh variable set DISCORD_GUILD_ID --body '<伺服器 ID>'
```

### 3. 註冊斜線指令（本機執行一次，指令有改時重跑）
```bash
cd backend
DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... \
    python tools/register_discord_commands.py
```

### 4. 部署後
1. Developer Portal → **General Information** → **Interactions Endpoint URL** 填
   `<Cloud Run 網址>/api/discord/interactions`（Discord 會立即送驗證請求，要部署好才填得進去）
2. 建立 Cloud Scheduler job：
   ```bash
   gcloud scheduler jobs create http discord-notify-tick \
     --schedule="* * * * *" --time-zone="Asia/Taipei" \
     --uri="<Cloud Run 網址>/api/internal/discord-notify/tick" --http-method=POST \
     --headers="Authorization=Bearer <ADMIN_API_KEY>" \
     --attempt-deadline=60s --max-retry-attempts=0
   ```
   `--max-retry-attempts=0`：下一分鐘本來就會再跑，不需要重試
3. 到網站「我的頻道設定 → Discord 開台與新影片通知」儲存一次設定（這一步會綁定伺服器，斜線指令才能用）

## 注意
- 通知依賴 WebSub 推播，頻道要在 `channel_sync_index` 裡（授權過的頻道每天由 `subscribe-all` 續訂）
- staging 與 production 的 Firestore 是分開的，同一個頻道只在一個環境開啟通知，否則會發兩次
