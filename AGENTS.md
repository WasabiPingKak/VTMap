# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Structure

```
├── backend/
│   ├── app.py                 # APIFlask app entry point (create_app factory)
│   ├── schemas/               # Pydantic request/response schemas
│   ├── routes/                # API route modules（自動掃描註冊）
│   ├── services/              # Business logic layer
│   │   ├── youtube/           # YouTube API integration
│   │   ├── firestore/         # Database operations
│   │   ├── video_analyzer/    # Video classification by title keywords
│   │   ├── trending/          # Trending channel/game analytics
│   │   ├── live_redirect/     # Live stream caching and routing
│   │   └── heatmap/           # Active time visualization
│   └── utils/                 # Shared utilities
│
├── frontend_react/
│   ├── src/
│   │   ├── pages/             # Page components
│   │   ├── components/        # Feature-grouped UI components
│   │   │   ├── channel/       # 頻道頁面 section（Overview/Video/Heatmap tabs）
│   │   │   ├── chart/         # 圖表元件（圓餅/長條/Treemap/Heatmap）
│   │   │   ├── channels/      # 頻道列表頁面元件
│   │   │   ├── common/        # 共用元件（VideoCard, ChannelInfoCard 等）
│   │   │   └── skeleton/      # Skeleton 載入佔位元件
│   │   ├── hooks/             # Custom React hooks
│   │   ├── stores/            # Zustand state stores
│   │   ├── types/             # TypeScript types
│   │   └── utils/             # Utility functions
│   └── public/                # Static assets
│
├── docs/
│   └── adr/                   # Architecture Decision Records
└── .github/workflows/         # CI/CD pipelines
```

## Development Commands

### Backend (backend/)
```bash
cd backend
pip install -r requirements-dev.txt  # 含 runtime + 開發工具（pytest、mypy、ruff 等）
python app.py                        # Run APIFlask server locally

# 測試（需先啟動 Firestore emulator）
firebase emulators:start --only firestore --project demo-test &
pytest                             # Run tests（無 emulator 時部分測試會 skip）
pytest --cov                       # Run tests with coverage
```

### Frontend (frontend_react/)
```bash
cd frontend_react
npm install
npm run dev          # Start dev server (Vite)
npm run build        # Production build
npm test             # Run tests (Vitest)
npm run test:watch   # Run tests in watch mode
```

### Linting & Formatting
```bash
# Pre-commit hooks
pre-commit run --all-files

# Backend — Ruff
cd backend
ruff check . --config ruff.toml       # Lint
ruff check . --config ruff.toml --fix # Lint + 自動修正
ruff format . --config ruff.toml      # Format

# Backend — mypy
cd backend
mypy .

# Frontend — ESLint
cd frontend_react
npm run lint
```

## Key Patterns

以下慣例直接影響開發方式，修改程式碼時務必遵守。技術決策背景請參閱 [`docs/adr/`](docs/adr/README.md)。

### Route 自動註冊

`utils/route_loader.py` 掃描 `routes/` 下所有模組，自動呼叫 `init_*` 開頭的函式。新增 route 只需在 `routes/` 建檔並定義 `init_<name>_route(app, db)` 或 `init_<name>_route(app)`，不需修改 `app.py`。

### 錯誤處理

路由層不需 try/except，直接 raise 對應例外即可：

- `NotFoundError(message)` → 404
- `AuthorizationError(message)` → 403
- `ExternalServiceError(message)` → 502
- `ConfigurationError(message)` → 500

全域 handler 在 `utils/exceptions.py` 統一轉為 JSON 回應。

### Pydantic 驗證

使用 APIFlask 的 `@bp.input(Schema)` decorator 做請求驗證，ValidationError 由 `schemas/__init__.py` 統一轉為 422。Schema 定義在 `schemas/` 目錄。

### Frontend

- `@/` alias 指向 `src/`
- Zustand 管理 client state，TanStack Query 管理 server state（12 小時快取 + localStorage 持久化）
- 所有頁面 lazy load + Suspense

## Code Style（專案特有）

- **Indent**: Python 4 spaces / Frontend 依 Prettier 預設

通用的語言、行寬、溝通習慣與 Git commit 規則請參閱 `~/.Codex/AGENTS.md`。
