[![CI](https://github.com/WasabiPingKak/VTMap/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/WasabiPingKak/VTMap/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/WasabiPingKak/619ea827e4b1022e088031c237d7a834/raw/coverage-badge.json)](https://github.com/WasabiPingKak/VTMap/actions/workflows/ci.yml)

# VTMap 頻道旅圖｜Vtuber TrailMap

**[www.vtubertrailmap.com](https://www.vtubertrailmap.com/)**

VTMap 是一套針對 Vtuber 頻道經營的分析與導流工具，解決 YouTube 後台缺乏「主題分類」與「直播導流」資訊的限制。透過標題關鍵字比對分類影片主題，協助創作者與觀眾快速掌握頻道內容，並提供自訂規則與隱私設定。

## 功能特色

### 頻道分析 Channel Analyzer

- 自動掃描所有影片標題，依據關鍵字歸類為四大主題：「雜談」「遊戲」「音樂」「節目」
- 統計影片數量與總時長，產出主題比例圖與分布趨勢
- 快速查閱每部影片的標題、時間、主題分類與長度
- 頻道持有者可自訂分類關鍵字，讓分類更貼近頻道風格

### 降落轉機塔臺 Live Redirect Helper

- 自動替每場直播貼上主題分類標籤
- 顯示「同時觀看人數」、「開播時間」、「主題」等資訊
- 可依主題分類與人氣排序篩選導流對象
- 解決 YouTube 官方導流系統無法顯示分類、時間與同時觀看人數的問題

### 頻道擁有者自訂功能

- 透過 Google OAuth 登入，連結 YouTube 頻道使用進階管理功能
- 開關頻道分析頁與導流頁的觀看權限
- 設定自訂的主題分類關鍵字
- 透過 Google Sheets 表單協作擴充遊戲別名清單

### 趨勢分析

- 每日熱門遊戲排行
- 頻道活躍時段熱力圖

## Tech Stack

| Layer      | Technology                                                                     |
| ---------- | ------------------------------------------------------------------------------ |
| Frontend   | React 19, TypeScript, Vite, Tailwind CSS, Zustand (state), TanStack Query, shadcn/ui |
| Backend    | APIFlask + Python, Gunicorn, Pydantic (request validation), Flask-Limiter (rate limiting) |
| Database   | Google Cloud Firestore（Production / Staging 雙資料庫隔離）                      |
| Hosting    | Google Cloud Run (backend), Firebase Hosting (frontend)                        |
| Async Jobs | Google Cloud Tasks (WebSub 訂閱等非同步作業)                                    |
| Linting    | Ruff (backend), ESLint (frontend), pre-commit hooks                            |
| Testing    | pytest (backend), Vitest (frontend)                                            |

## 架構

```
Browser --> Firebase Hosting (React SPA)
                |
                | TanStack Query (12hr cache + localStorage)
                v
           Cloud Run (Flask API)
                |
                ├──> Firestore
                ├──> YouTube Data API v3
                └──> Cloud Tasks ──> WebSub (push notifications)
```

- Staging / Production 環境透過獨立 Firestore 資料庫完全隔離
- POST 路由使用 Pydantic schema 驗證，ValidationError 統一回傳 422
- WebSub 推播通知即時同步新影片資訊

## 快速開始

### 前置需求

- [Node.js](https://nodejs.org/) >= 18
- [Python](https://www.python.org/) >= 3.11
- [Google Cloud SDK](https://cloud.google.com/sdk)（存取 Firestore 用）
- [Firebase CLI](https://firebase.google.com/docs/cli)（前端部署用）
- 已啟用 Firestore 與 Cloud Tasks 的 GCP 專案

### 安裝

1. **Clone 專案**

   ```bash
   git clone https://github.com/WasabiPingKak/VTMap.git
   cd VTMap
   ```

2. **後端**

   ```bash
   cd backend
   python -m venv venv
   source venv/bin/activate  # Windows: venv\Scripts\activate
   pip install -r requirements.txt
   cp .env.example .env.local  # 填入你的環境變數
   ```

3. **前端**

   ```bash
   cd frontend_react
   npm install
   ```

4. **GCP 認證**

   ```bash
   gcloud auth application-default login
   gcloud config set project <your-gcp-project>
   ```

### 環境變數

完整欄位參考 `backend/.env.example`，主要分組：

| 分組 | 變數 | 說明 |
|------|------|------|
| Firestore | `FIRESTORE_DATABASE`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_APPLICATION_CREDENTIALS`, `FIREBASE_KEY_PATH` | 資料庫連線 |
| Google OAuth | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `FRONTEND_BASE_URL` | 登入流程 |
| YouTube API | `API_KEY` | YouTube Data API v3 |
| 認證與權限 | `JWT_SECRET`, `ADMIN_CHANNEL_IDS`, `ADMIN_API_KEY` | JWT 簽發、管理員判定、內部 API |
| WebSub | `WEBSUB_CALLBACK_URL`, `WEBSUB_SECRET` | 推播通知 |
| Cloud Tasks | `CLOUD_TASKS_LOCATION`, `CLOUD_TASKS_QUEUE`, `CLOUD_RUN_SERVICE_URL` | 非同步作業 |
| 遊戲別名 | `GAME_ALIAS_ENDPOINT` | 外部遊戲別名 API |
| 綠界金流 | `ECPAY_MERCHANT_ID`, `ECPAY_HASH_KEY`, `ECPAY_HASH_IV` | 選填，僅贊助功能需要 |

`.env.production` 覆蓋正式部署的網址與導向參數。

### 本地開發

```bash
# 後端（在 backend/ 目錄下）
python app.py

# 前端（在 frontend_react/ 目錄下）
npm run dev
```

### 測試與 Lint

```bash
# 後端測試
cd backend
pytest
pytest --cov

# Pre-commit hooks（Ruff + ESLint + .env 保護）
pre-commit install
pre-commit run --all-files

# 手動 Lint
cd backend && ruff check . --config ruff.toml
cd frontend_react && npm run lint
```

## 部署

部署由 GitHub Actions 自動執行，push 到對應分支即觸發：

- **Staging**: push 到 `develop` → `.github/workflows/deploy-staging.yml`
- **Production**: push 到 `main` → `.github/workflows/deploy-production.yml`

每個 workflow 包含品質閘門（lint + test），通過後才部署 Backend（Cloud Run）與 Frontend（Firebase Hosting）。

### Firestore 資料庫環境隔離

專案使用**雙資料庫**架構，確保 Staging 和 Production 環境完全隔離：

- **Production**: 使用 `(default)` 資料庫
- **Staging**: 使用 `staging` 資料庫

環境變數 `FIRESTORE_DATABASE` 控制連線的資料庫，部署腳本會自動根據 `.env.staging` 或 `.env.production` 設定。

### 資料庫遷移工具

使用 `migrate_prod_to_staging.py` 將 Production 資料複製到 Staging 進行測試：

```bash
cd backend

# 完整複製（保留 90 天資料，自動脫敏）
python tools/migrate_prod_to_staging.py --full --days 90

# 複製所有歷史資料（不過濾）
python tools/migrate_prod_to_staging.py --full --all-history

# 只複製指定 Collections
python tools/migrate_prod_to_staging.py --collections channel_data,channel_index_batch --days 90

# Dry Run 模式（只顯示會複製什麼，不實際寫入）
python tools/migrate_prod_to_staging.py --full --days 90 --dry-run

# 保留敏感資料模式（不脫敏，僅用於特殊測試）
python tools/migrate_prod_to_staging.py --full --days 90 --no-sanitize
```

**安全機制**：
- 自動脫敏：移除 OAuth tokens 等敏感資料
- 安全檢查：禁止從 Staging 複製到 Production
- 互動確認：執行前需輸入 'yes' 確認
- 進度顯示：即時顯示複製進度與統計

## 專案結構

```
VTMap/
├── backend/
│   ├── app.py                 # APIFlask 入口（Application Factory）
│   ├── schemas/               # Pydantic request/response schemas
│   ├── routes/                # API 路由模組
│   ├── services/              # 商業邏輯層
│   │   ├── youtube/           # YouTube API 串接
│   │   ├── firestore/         # 資料庫操作
│   │   ├── video_analyzer/    # 影片標題關鍵字分類
│   │   ├── trending/          # 熱門頻道 / 遊戲分析
│   │   ├── live_redirect/     # 直播快取與導流
│   │   └── heatmap/           # 活躍時段熱力圖
│   ├── utils/                 # 共用工具（rate limiter、JWT 等）
│   └── tools/                 # 維運腳本（資料庫遷移等）
│
├── frontend_react/
│   ├── src/
│   │   ├── pages/             # 頁面元件
│   │   ├── components/        # 依功能分群的 UI 元件
│   │   ├── hooks/             # Custom React hooks
│   │   ├── stores/            # Zustand state stores
│   │   ├── types/             # TypeScript 型別定義
│   │   └── utils/             # 工具函式
│   └── public/                # 靜態資源
│
└── README.md
```
