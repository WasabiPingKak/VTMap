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
python -m crawler expand                           # 補排未爬頻道 + 重算優先權
python -m crawler status                           # 佇列與資料統計
python -m crawler enrich-channels                  # 補完頻道正式名稱/handle/頭像
python -m crawler serve --port 5001                # 前端開發用迷你 API server
```

`enrich-channels` 用 YouTube Data API `channels.list`(50 頻道/1 unit,數百頻道
只花個位數 units),補完 `title`(正式名稱)、`handle`(@代稱)、`thumbnail_url`
(240px 頭像)。聊天室來的發言者名稱是 handle,存 `handle` 欄位不佔用 `title`。
爬完一批後跑一次即可,已補完的頻道(`enriched_at`)不會重查。

前端本機開發:啟動 serve 後,在 `frontend_react/.env.local` 設
`VITE_NETWORK_API_BASE=http://127.0.0.1:5001`,`/network` 頁即可吃到真資料。

## 管線流程

```
seed(收錄頻道, depth=0) → list_videos(近 10 部抓得到的直播 VOD)
  → fetch_chat(yt-dlp 下載 replay → 解析 badge)
      → 寫入 chat_badge_observations + 新頻道入 channels(depth+1)
      → check_qualification(檢查「曾經有直播紀錄」准入規則)
          → 合格(且未超過 CRAWLER_MAX_DEPTH)→ 排回 list_videos(往外擴張)
```

## 擴張範圍與優先權

擴張預設不設深度上限(`CRAWLER_MAX_DEPTH=-1`),改由佇列優先權決定先爬誰、
用 `run --max-tasks` 的預算決定一次爬多少。優先權公式:

```
priority = 連結度 × 1000 + 訂閱數級距(log10 × 100,上限 999)
```

連結度(目前在 `network_edges` 上的邊數)永遠壓過訂閱數。實測這兩個訊號幾乎反向:
幫最多人管台的是幾百訂閱的小頻道,十萬訂閱以上的大頻道多半只有一條邊。以連結度
優先會先把社群的連結者爬完,圖較快變密。

連結度與訂閱數都會隨爬取變動,而新發現的頻道要跑過 `enrich-channels` 才有訂閱數,
所以每批的順序是:

```bash
python -m crawler enrich-channels        # 補完新頻道的訂閱數
python -m crawler expand                 # 補排未爬頻道 + 依最新資料重算優先權
python -m crawler run --max-tasks 1000   # 跑一批
```

`expand` 是必要的,因為 check_qualification 的去重是永久的:放寬深度上限後,
先前被深度擋下的頻道不會自己重排。

`list_videos` 會掃描 `CRAWLER_BACKFILL_VIDEOS × CRAWLER_LIST_SCAN_MULTIPLIER` 部,
在列表階段就濾掉會員限定(`availability` 為 `subscriber_only` 等)與進行中/預定的
直播,再取前 N 部排入 fetch_chat。這樣回溯額度不會被抓不到的影片佔掉,代價是
會員限定比例高的頻道會回溯到較舊的直播。

邊(`network_edges` view)由觀察資料即時推導:雙方非同一頻道、author 通過准入、
非 bot 的管理員關係,正規化為無向(channel_a < channel_b)。調整准入規則只需改
view,不需重爬。

## 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `SUPABASE_DB_URL` | 讀 `.env.local` | Postgres 連線字串 |
| `CRAWLER_DB_SCHEMA` | `staging` | 目標 schema;production 設 `public` |
| `CRAWLER_BACKFILL_VIDEOS` | 10 | 每頻道回溯 VOD 數 |
| `CRAWLER_LIST_SCAN_MULTIPLIER` | 3 | 列表掃描倍率(掃 10×3 部,濾掉抓不到的取前 10) |
| `CRAWLER_MAX_DEPTH` | -1 | 擴張深度上限(種子=0);-1 = 不設限 |
| `CRAWLER_MIN_SUBSCRIBERS` | 100 | 低於此訂閱數不排入爬取(圖上也會被濾掉) |
| `CRAWLER_TASK_SLEEP` | 6 | 任務間隔秒數(另加隨機抖動) |
| `YOUTUBE_API_KEY` | 讀 `.env.local` | enrich-channels 用的 YouTube Data API key |

## Schema 分環境

同一個 Supabase project 以 Postgres schema 區分環境:`staging`(開發/測試)與
`public`(production)。migration 檔不含 schema 前綴,執行時由 `search_path`
決定落點,兩個環境共用同一份 migration 檔,各自有獨立的 `schema_migrations`。

## 注意事項

- 佇列去重是永久的(done 任務不會重排);之後做每日增量時再設計重跑策略
- yt-dlp 走非官方管道,YouTube 改版可能導致失效,升級 yt-dlp 通常可解
- 會員(member)badge 解析器有支援,但依產品決定初版只入庫管理員資料
