# Architecture Decision Records (ADR)

本目錄記錄 VTMap 專案的重要架構決策。每份 ADR 說明決策背景、選項評估、最終決定及其影響。

## 格式

採用 [Michael Nygard 的 ADR 模板](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)，
以繁體中文撰寫。

## 索引

| 編號 | 標題 | 狀態 |
|------|------|------|
| [ADR-001](001-apiflask-application-factory.md) | 使用 APIFlask + Application Factory 模式 | 已採用 |
| [ADR-002](002-route-auto-registration.md) | Route 自動註冊機制 | 已採用 |
| [ADR-003](003-exception-hierarchy-error-handling.md) | 領域例外階層與全域錯誤處理 | 已採用 |
| [ADR-004](004-circuit-breaker.md) | 自製 Circuit Breaker 保護外部服務 | 已採用 |
| [ADR-005](005-firestore-dual-database.md) | Firestore 雙資料庫環境隔離 | 已採用 |
| [ADR-006](006-kms-token-encryption.md) | Google Cloud KMS 加密 Refresh Token | 已採用 |
| [ADR-007](007-opentelemetry-cloud-trace.md) | OpenTelemetry 分散式追蹤整合 Cloud Trace | 已採用 |
| [ADR-008](008-frontend-state-management.md) | 前端狀態管理：Zustand + TanStack Query | 已採用 |
| [ADR-009](009-mypy-migration.md) | 靜態型別檢查從 pyright 遷移至 mypy | 已採用 |
| [ADR-011](011-discord-notify-http-only.md) | Discord 開台與新影片通知採用純 HTTP 架構 | 已採用 |
