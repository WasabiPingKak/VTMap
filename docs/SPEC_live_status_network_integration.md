# 直播中狀態整合關係網路 — 實作規格

**Status**: 暫緩 — 等待前置重構完成

**Last updated**: 2026-09-02

---

## 前置決策(阻擋本規格)

先重構原本的 live-redirect 系統,把 Firestore 的頻道/直播相關資料搬到 Supabase,再啟動本規格的工作。

**原因**:目前 VTMap 有兩套頻道資料源並存 —

- Firestore `channel_sync_index` + `live_redirect_cache` + `live_redirect_notifications`:live-redirect 系統用
- Supabase `channels` + `crawl_queue` + 關係網路相關表:關係網路爬蟲用

如果本規格直接開工,只會把 WebSub 分成「舊機制走 Firestore、新機制走 Supabase」兩套並存,把技術債往後推。決定先把 live-redirect 相關資料統一到 Supabase,之後 WebSub 訂閱路徑與收播偵測都只有一套。

**重構完成後可以簡化的部分**:
- D(WebSub 擴大訂閱)的分工原則消失,不需要區分「哪些頻道走哪套」
- ADR 從「兩套並存」變成「已統一」
- 訂閱池條件從「Supabase 且不在 Firestore」變成「Supabase 全部符合條件的」
- Crawler 自動訂閱不需要跨系統對照

---

## 功能總覽

在網路圖上顯示「直播中」節點,收播 24 小時後把該直播的聊天室重爬撈新關係,並建立 WebSub 訂閱的長期維護機制。

參考來源:VTaxon(`D:\Github_Local_Workspace\VTaxon`)

## 已確認決策

| # | 主題 | 選項 | 決策 |
|---|---|---|---|
| 1 | 視覺強度 | 全搬 VTaxon 三層 / 只留 halo / 只留紅點 | **全搬三層** |
| 2 | Filter 型態 | Hard filter(隱藏)/ Soft(變暗) | **Hard + 隱藏開關** |
| 3 | Upcoming 顯示 | 顯示 / 不顯示 | **不顯示** |
| 4 | Rescan kind | 新 kind / 重用 fetch_chat | **新 kind `rescan_chat`** |
| 5 | Rescan 延遲 | 立刻 / 15 分鐘 / 1 小時 / 24 小時 | **24 小時**(YouTube 收播後有處理時間) |
| 6 | Rescan 順位公式 | 各種選項 | **`priority = degree`**(不乘 1000,永遠輸 list_videos 但贏預設 0) |
| 7 | 偵測位置 | Cloud Scheduler cron / 本機爬蟲 / 前端 request-driven | **Cloud Scheduler cron 每 5 分鐘** |
| 8 | WebSub 訂閱池 | 1,717 有直播歷史 / 全 4,303 / 更嚴 filter | **1,717 有直播歷史的** |
| 9 | WebSub state 儲存 | Supabase 加欄位 / Firestore 新 collection / 不追蹤 | **Supabase 加欄位**(重構後) |
| 10 | 首次批次觸發 | Admin endpoint / CLI / 併進 crawler | **Admin endpoint + Crawler 自動增量**(先手動跑一次,之後爬蟲自動維護) |

---

## A. 前端 live 節點視覺(1 天)

### 視覺(全搬 VTaxon)

- **脈動 halo**:節點外圈,`sin(now/1000)` 呼吸,`shadowBlur 12`,色 `#FF6B35`(橘紅)
- **左上角紅點**:半徑 5,`sin(now/600)` 較快呼吸
- **名字下方 LIVE pill**:紅底(`rgba(239,68,68,0.9)`)白字,內含小白點脈動
- VTMap 節點是圓形,用 `ctx.arc` + stroke 取代 VTaxon 的 hex 繪製,其他公式一比一

### Filter

- Toolbar 加「只看直播中」toggle → hard filter(隱藏非 live + camera fit)
- Toolbar 加 `liveCount` badge 顯示當下直播中數量

### DetailPanel

選中直播中節點時加區塊:標題、觀看人數、開播時間、YouTube 連結

### Join 策略

Client 端 join,`useNetworkGraph` + `useLiveRedirectData` 兩個 hook 各自快取,map by channel_id

### 檔案改動

| 動作 | 檔案 |
|---|---|
| 編輯 | `frontend_react/src/components/network/renderers.ts` |
| 編輯 | `frontend_react/src/components/network/GraphCanvas.tsx` |
| 編輯 | `frontend_react/src/components/network/NetworkToolbar.tsx` |
| 編輯 | `frontend_react/src/components/network/DetailPanel.tsx` |
| 編輯 | `frontend_react/src/types/network.ts`(加 `live?: {...}`) |
| 新建 | `frontend_react/src/hooks/useNetworkWithLive.ts` |

---

## B. 收播偵測 cron(幾小時)

### 關鍵發現

`backend/services/live_redirect/cache_updater.py:208 _lazy_refresh_endtime()` 已經在做核心邏輯 — 掃 cache 裡 `endTime is null` 的影片、打 YouTube API、更新收播時間。只是被動觸發,靠前端流量。實測 cache 顯示可以 8 小時沒更新過。

### 設計

**新端點**:`POST /api/livestream/youtube-check-offline`(X-Cron-Secret 保護)

**流程**:
1. 呼叫抽出來的 lazy refresh 函數
2. Diff live→ended:比較呼叫前後 cache,找出新收播的 videoIds
3. 每個收播的 videoId → enqueue `rescan_chat` 到 Supabase `crawl_queue`(scheduled_at = now + 24h, priority = degree)
4. 異常防護:若 ≥ 5 個影片同時收播,只 log alert 不 enqueue(懷疑 API 暫故障)

**Cloud Scheduler**:每 5 分鐘

**成本**:288-576 units/day(佔 quota 3-6%)

### 檔案改動

| 動作 | 檔案 |
|---|---|
| 編輯 | `backend/services/live_redirect/cache_updater.py`(抽出 lazy refresh) |
| 新建 | `backend/routes/livestream_check_offline_route.py` |

---

## C. rescan_chat 新 kind(1 天)

### Schema migration

```sql
alter table crawl_queue add column scheduled_at timestamptz;
```

### 邏輯

- 新 kind:`KIND_RESCAN_CHAT = "rescan_chat"`
- Priority 公式:`priority = degree`(不乘 1000)
- `claim_next_task` SQL 加條件:`and (scheduled_at is null or scheduled_at <= now())`
- Handler:重用 fetch_chat 下載/parse 邏輯,對特定 video_id 重跑,observations 用 upsert(既有邏輯已支援)

### 檔案改動

| 動作 | 檔案 |
|---|---|
| 新建 | `supabase/migrations/xxxx_crawl_queue_scheduled_at.sql` |
| 編輯 | `backend/crawler/repo.py`(加 kind、修 claim SQL、支援 scheduled_at) |
| 編輯 | `backend/crawler/pipeline.py`(加 rescan handler) |
| 編輯 | `backend/crawler/__main__.py`(加 rescan_chat 到 kinds choices) |

---

## D. WebSub 擴大訂閱(半週)

### Schema migration

```sql
alter table channels add column websub_subscribed_at timestamptz;
alter table channels add column websub_status text;  -- 'active' | 'failed' | null
```

### 訂閱池(重構後)

`has_stream_history=true AND is_bot=false`(統一到 Supabase 後,不需要跟 Firestore 對照排除)

### 新 endpoints

| 端點 | 保護 | 用途 | 頻率 |
|---|---|---|---|
| `POST /api/websub/subscribe-network-channels` | X-Admin-Secret | 首次批次訂閱 | 手動觸發一次 |
| `POST /api/websub/renew-network-subs` | X-Cron-Secret | Renew 快過期的 | 每 12 小時 |
| `POST /api/websub/cleanup-notifications` | X-Cron-Secret | 清 > 7 天 notification | 每 24 小時 |

### Crawler 自動訂閱(增量維護)

- `check_qualification` handler 判定 `has_stream_history=true` 時,直接呼叫 hub 訂閱
- 更新 Supabase `websub_subscribed_at = now()`
- 首次要先手動打一次 admin endpoint 補齊既有頻道

### Renew 策略

掃 `websub_subscribed_at < now() - 5 days` 的頻道,重新 subscribe hub

### 檔案改動

| 動作 | 檔案 |
|---|---|
| 新建 | `backend/routes/websub_subscribe_network_route.py` |
| 新建 | `backend/routes/websub_renew_route.py` |
| 新建 | `backend/routes/websub_cleanup_route.py` |
| 新建 | `backend/services/websub/hub_client.py`(共用 hub.subscribe) |
| 新建 | `supabase/migrations/xxxx_channels_websub_state.sql` |
| 編輯 | `backend/crawler/pipeline.py`(check_qualification 成功時呼叫 hub) |
| 編輯 | `backend/crawler/settings.py`(加 WEBSUB_HUB_URL、CALLBACK_URL) |

---

## Ship 順序

前置:live-redirect Firestore → Supabase 重構完成

| Phase | 內容 | 工作量 | 可獨立 ship? |
|---|---|---|---|
| **1** | A 前端視覺(先用現有 live 資料) | 1 天 | ✅ |
| **2** | D schema + first-time batch endpoint | 1 天 | ✅ |
| **3** | D renew cron + cleanup cron | 1 天 | ✅ |
| **4** | B 收播偵測 cron(重用 lazy refresh) | 幾小時 | ✅ |
| **5** | C rescan_chat 新 kind | 1 天 | ✅ |
| **6** | D crawler 自動訂閱 | 半天 | ✅ |

**總工作量**:~5 個工作天

---

## 開始前要確認的 5 件事

1. **Backend 有沒有 Supabase 寫入權限**(重構後應該會有,但要驗證)
2. **首次批次 subscribe(訂 1,717 個)要不要走 Cloud Tasks**(現有 `subscribe-all` 用 Cloud Tasks,建議一致)
3. **Anomaly 門檻**:VTaxon 用 ≥ 5 同時收播就 alert,VTMap 沿用嗎
4. **VTMap GCP 有 Cloud Scheduler 在用嗎**(有 → 複製 pattern;沒 → 首次要多花時間開 API + 設 auth)
5. **Ship 策略**:6 個 PR 循序 / A 先 + 後端一起

---

## 參考來源

- VTaxon 專案(`D:\Github_Local_Workspace\VTaxon`)
  - 視覺設計:`frontend/components/graph/`
  - 收播偵測:`backend/app/routes/subscriptions.py` `youtube_check_offline` + `backend/app/services/youtube_pubsub.py` `check_streams_ended`
  - WebSub renew:`backend/app/services/subscriptions/youtube.py` `youtube_renew_subs`
- VTMap 既有實作
  - `backend/services/live_redirect/cache_updater.py`(收播被動偵測邏輯)
  - `backend/routes/websub_subscribe_route.py` `subscribe-all`(既有批次訂閱)
- 生產資料 snapshot(2026-09-02 離峰)
  - live_redirect_cache: 201 頻道,live_now=2, upcoming=39, ended_today=158
  - Supabase channels: 4,303,has_stream_history & 非 bot = 1,717
