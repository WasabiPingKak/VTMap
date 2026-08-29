# VTuber 關係網路爬蟲

從已結束直播的聊天室 replay 擷取管理員 badge,建立頻道關係資料(存於 Supabase Postgres)。

**本機執行的 CLI 工具**,不隨後端部署到 Cloud Run(避免資料中心 IP 被 YouTube 阻擋,
詳見決策討論)。聊天室資料統一走 yt-dlp 爬取,不消耗 YouTube API quota。

## 需求

- Python 3.10+(爬蟲相容 3.10;後端其他程式碼需 3.12)
- `pip install -r requirements-dev.txt`(含 `psycopg[binary]`、`yt-dlp`)
- `backend/.env.local` 內含 `SUPABASE_DB_URL=postgresql://...`(Session pooler 連線字串)

## 用法

```bash
cd backend
python -m crawler migrate                          # 套用 supabase/migrations/*.sql
python -m crawler seed --api-base https://<站台>   # 從 /api/channels/index 載入種子
python -m crawler add-channel UCxxxx               # 手動加入單一種子
python -m crawler run                              # 消化佇列直到清空
python -m crawler run --max-tasks 5 --kinds fetch_chat   # 限量/限類型
python -m crawler status                           # 佇列與資料統計
python -m crawler serve --port 5001                # 前端開發用迷你 API server
```

前端本機開發:啟動 serve 後,在 `frontend_react/.env.local` 設
`VITE_NETWORK_API_BASE=http://127.0.0.1:5001`,`/network` 頁即可吃到真資料。

## 管線流程

```
seed(收錄頻道, depth=0) → list_videos(近 10 部直播 VOD)
  → fetch_chat(yt-dlp 下載 replay → 解析 badge)
      → 寫入 chat_badge_observations + 新頻道入 channels(depth+1)
      → check_qualification(檢查「曾經有直播紀錄」准入規則)
          → 合格且 depth <= CRAWLER_MAX_DEPTH → 排回 list_videos(往外擴張)
```

邊(`network_edges` view)由觀察資料即時推導:雙方非同一頻道、author 通過准入、
非 bot 的管理員關係,正規化為無向(channel_a < channel_b)。調整准入規則只需改
view,不需重爬。

## 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `SUPABASE_DB_URL` | 讀 `.env.local` | Postgres 連線字串 |
| `CRAWLER_DB_SCHEMA` | `staging` | 目標 schema;production 設 `public` |
| `CRAWLER_BACKFILL_VIDEOS` | 10 | 每頻道回溯 VOD 數 |
| `CRAWLER_MAX_DEPTH` | 1 | 擴張深度上限(種子=0) |
| `CRAWLER_TASK_SLEEP` | 6 | 任務間隔秒數(另加隨機抖動) |

## Schema 分環境

同一個 Supabase project 以 Postgres schema 區分環境:`staging`(開發/測試)與
`public`(production)。migration 檔不含 schema 前綴,執行時由 `search_path`
決定落點,兩個環境共用同一份 migration 檔,各自有獨立的 `schema_migrations`。

## 注意事項

- 佇列去重是永久的(done 任務不會重排);之後做每日增量時再設計重跑策略
- yt-dlp 走非官方管道,YouTube 改版可能導致失效,升級 yt-dlp 通常可解
- 會員(member)badge 解析器有支援,但依產品決定初版只入庫管理員資料
