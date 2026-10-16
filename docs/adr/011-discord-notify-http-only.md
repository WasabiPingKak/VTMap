# ADR-011: Discord 開台與新影片通知採用純 HTTP 架構

## 狀態
已採用 (2026-10-17)

## 背景
需要一個 Discord 機器人，在 YouTube 直播開台時、以及上傳長片 / Shorts / 首播開始時，
分別發訊息到不同的 Discord 頻道。訊息內容可自訂並可 tag 身分組，設定可在網站上改，
也可以在 Discord 裡用斜線指令改。第一版只開放管理員使用，但設計要能擴充給所有登入的頻道。

Discord 機器人常見做法是 `discord.py` 走 Gateway（WebSocket 長連線），需要一台 24 小時常駐的主機，
跟 Cloud Run 有請求才啟動的模式不合。

## 決策

### 1. 不使用 Gateway，全部走 HTTP
- 發訊息、讀頻道與身分組清單：Discord REST API + Bot Token
- 斜線指令：Discord Interactions Endpoint，Discord 把指令 POST 到 `/api/discord/interactions`，
  以 Ed25519 驗簽（`pycryptodome`，不新增套件）
- 不需要任何 Privileged Gateway Intent

### 2. 偵測流程：WebSub 排入佇列 + Cloud Scheduler 每分鐘 tick
- `websub-callback` 收到有開通知的頻道推播時，額外寫入 `discord_notify_queue`
- `/api/internal/discord-notify/tick` 每分鐘執行：
  - 佇列與「預定時間快到」的待機室合併成**一次批次查詢**（`videos.list` 一次 50 支，1 單位 quota）
  - 一般上傳 → 影片通知，待機室 → 寫入 `discord_notify_pending`，開台 → 直播通知
- 不用 Cloud Tasks，避免重試燒錢（見 2026-09 帳單事件）。延遲最多 1 分鐘

不依賴 `live_redirect_cache` 的原因：那份快取只在有人瀏覽網站時才重建，沒人逛網站時偵測不到開台。

### 3. 影片分類規則（`services/discord_notify/classifier.py`）
- 直播與首播都有 `liveStreamingDetails`。**開始前與進行中**用片長區分：直播是 `P0D`，首播影片已上傳完成，片長不為 0
- **已結束**的影片直播檔也有片長，改用與 `get_video_type` 相同的規則：`actualStartTime` 與 `publishedAt` 相差 < 5 分鐘才是首播
- Shorts：片長 ≤ 3 分鐘（2024-10 起的上限）再對 `/shorts/{id}` 發 HEAD 確認，200 為 Shorts
- 首播歸「影片」，在首播開始時發送。待機室建立時不發預告
- 發布超過 24 小時的影片（改標題等操作觸發的推播）不通知

### 4. 去重
`discord_notify_sent/{videoId}` 以 Firestore `create()` 先佔位再發送，文件已存在即跳過。
發送失敗會刪除佔位，下次 tick 重試，最多 5 次。

## 成本
- Cloud Scheduler 依 job 數計費（每月 3 個免費），與執行頻率無關
- 每分鐘 tick 約 4.3 萬次請求 / 月，在 Cloud Run 免費額度內。無額度時約 $0.35 / 月
- 擴充給所有人時，第一個天花板是 YouTube quota，批次查詢 + 只查快開台的待機室可壓在每天約 1,440 單位

## 影響
- Firestore 新增 `discord_notify_config`、`discord_notify_queue`、`discord_notify_pending`、`discord_notify_sent`
- 新環境變數：`DISCORD_BOT_TOKEN`（Secret Manager），`DISCORD_PUBLIC_KEY`、`DISCORD_GUILD_ID`（GitHub variables，非機密）
- 一個 Discord Application 只能設定一個 Interactions Endpoint URL，staging 與 production 需各用一個 Application，
  或只在其中一個環境啟用斜線指令
- 開放給所有人時需要：移除 `_require_admin`、做「加到 Discord」的邀請綁定流程（OAuth2 回傳 `guild_id`）、
  機器人改為公開，超過 100 個伺服器需通過 Discord 驗證
