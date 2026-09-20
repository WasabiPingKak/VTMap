# WebSub 訂閱機制改用 Cloud Tasks 遷移指南

> **狀態**: 已實作完成 — `utils/cloud_tasks_client.py` 與 `routes/websub_subscribe_route.py` 已上線運作

## 問題背景

`websub-subscribe-all` Cloud Scheduler job 長期失敗，原因：
- 同步迴圈逐一訂閱所有頻道，頻道數多時超過 Cloud Scheduler / Cloud Run timeout
- Cloud Scheduler 預設 HTTP timeout 約 180 秒，頻道數超過 ~100 就會超時
- 失敗後 Cloud Tasks 自動 retry，但每次都會再超時，形成永久失敗

## 解決方案

將 `subscribe-all` 從「同步迴圈」改為「Cloud Tasks 非同步派發」：

```
之前：Scheduler → subscribe-all → for 迴圈逐一訂閱 200+ 頻道 → timeout ❌
之後：Scheduler → subscribe-all → 建立 200+ 個 Cloud Task（幾秒完成）✅
                                        ↓
                Cloud Tasks → subscribe-one?channel_id=UC001
                Cloud Tasks → subscribe-one?channel_id=UC002
                ...（每個獨立執行，失敗自動 retry）
```

## 需要的變更

### 1. GCP 設定（一次性）

```bash
# 啟用 Cloud Tasks API
gcloud services enable cloudtasks.googleapis.com

# 建立 queue（每秒最多 5 個、最多同時 5 個、失敗重試 3 次、重試間隔 5 分鐘起跳）
gcloud tasks queues create websub-subscribe \
  --location=asia-east1 \
  --max-dispatches-per-second=5 \
  --max-concurrent-dispatches=5 \
  --max-attempts=3 \
  --min-backoff=300s \
  --max-doublings=3
```

> **重試參數一定要顯式指定。** Cloud Tasks 的預設值是重試 100 次、最短間隔 0.1 秒、
> 同時派發 1000 個。hub 故障時每次重試都會佔住 Cloud Run 直到逾時，
> 預設值會把計費時間放大數十倍（見文末「2026-09 hub 故障事件」）。

### 2. 新增套件

在 `requirements.txt` 加入：
```
google-cloud-tasks
```

### 3. 新增 Cloud Tasks 工具模組

建立 `utils/cloud_tasks_client.py`：

```python
"""
Cloud Tasks 工具模組 — 將任務派發到 Cloud Tasks queue 非同步執行。
"""

import json
import logging
import os

from google.cloud import tasks_v2
from google.protobuf import timestamp_pb2

logger = logging.getLogger(__name__)

_PROJECT_ID = os.getenv("GOOGLE_CLOUD_PROJECT")
_LOCATION = os.getenv("CLOUD_TASKS_LOCATION", "asia-east1")
_QUEUE_NAME = os.getenv("CLOUD_TASKS_QUEUE", "websub-subscribe")
_SERVICE_URL = os.getenv("CLOUD_RUN_SERVICE_URL", "")

_client = None


def _get_client() -> tasks_v2.CloudTasksClient:
    global _client
    if _client is None:
        _client = tasks_v2.CloudTasksClient()
    return _client


def dispatch_task(
    path: str,
    *,
    params: dict | None = None,
    method: str = "POST",
) -> str | None:
    if not _PROJECT_ID or not _SERVICE_URL:
        logger.error(
            "❌ Cloud Tasks 設定不完整："
            f"PROJECT={_PROJECT_ID}, SERVICE_URL={_SERVICE_URL}"
        )
        return None

    client = _get_client()
    queue_path = client.queue_path(_PROJECT_ID, _LOCATION, _QUEUE_NAME)

    url = f"{_SERVICE_URL.rstrip('/')}{path}"
    if params:
        query = "&".join(f"{k}={v}" for k, v in params.items())
        url = f"{url}?{query}"

    task = {
        "http_request": {
            "http_method": tasks_v2.HttpMethod.POST if method == "POST" else tasks_v2.HttpMethod.GET,
            "url": url,
            "headers": {"Content-Type": "application/json"},
        }
    }

    try:
        created = client.create_task(parent=queue_path, task=task)
        logger.info(f"📤 已建立 Cloud Task：{created.name}")
        return created.name
    except Exception:
        logger.error(f"🔥 建立 Cloud Task 失敗：{url}", exc_info=True)
        return None


def dispatch_tasks_batch(
    path: str,
    *,
    params_list: list[dict],
    method: str = "POST",
) -> dict:
    dispatched = 0
    failed = 0
    for params in params_list:
        result = dispatch_task(path, params=params, method=method)
        if result:
            dispatched += 1
        else:
            failed += 1
    return {"dispatched": dispatched, "failed": failed}
```

### 4. 改寫 websub subscribe route

**關鍵改動：**

- `subscribe-all`：不再 for 迴圈呼叫 PubSubHubbub，改為建立 Cloud Tasks
- `subscribe-one`：保留原有訂閱邏輯，作為 Cloud Task 的 handler
- `subscribe-one` 失敗時回傳 HTTP 500，讓 Cloud Tasks 自動 retry
- 對 hub 的請求逾時為 5 秒（`HUB_TIMEOUT_SECONDS`）。hub 正常時 1 秒內回 202，
  故障時要約 20 秒才回 503，等它只是白白佔用運算時間
- `subscribe-all` 派發前先探測 hub（`_probe_hub`）：對前 3 個頻道依序做真實訂閱，
  有一個成功就照常派發其餘頻道。全部失敗就判定 hub 故障，略過本輪、
  在 `scheduler_job_logs` 記一筆 `status="skipped"`，並回 502 讓 Cloud Scheduler 顯示該次執行失敗
- `CALLBACK_URL` 改為每次 request 時讀取（避免 module-level 快取問題）
- 新增 `_log_job_result()` 寫入 Firestore `scheduler_job_logs` 記錄執行結果

```python
# subscribe-all 核心邏輯（簡化版）
def subscribe_all_channels():
    channels = 從 Firestore 讀取頻道列表

    # 過濾出有效 channel_id
    valid_params = [{"channel_id": ch["channel_id"]} for ch in channels if ch.get("channel_id")]

    # 透過 Cloud Tasks 批次派發
    result = dispatch_tasks_batch("/api/websub/subscribe-one", params_list=valid_params)

    # 記錄到 Firestore
    _log_job_result(db, "websub-subscribe-all", result)
    return jsonify(result), 200
```

### 5. 部署腳本新增環境變數

在 `deploy_backend.sh` 的 `--set-env-vars` 加入：

```
CLOUD_TASKS_LOCATION=${REGION}
CLOUD_TASKS_QUEUE=websub-subscribe
CLOUD_RUN_SERVICE_URL=${CLOUD_RUN_SERVICE_URL}
```

其中 `CLOUD_RUN_SERVICE_URL` 在部署前取得：

```bash
CLOUD_RUN_SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --region="$REGION" \
  --format="value(status.url)" 2>/dev/null || echo "")
```

### 6. Cloud Scheduler 確認事項

確保 `websub-subscribe-all` job 的目標 URL 指向 **production** service，不是 staging。

排程為**每天一次**（`0 3 * * *`，Asia/Taipei）。hub 給的訂閱租約固定 5 天
（驗證 GET 帶的 `hub.lease_seconds=432000`），每天續訂要連續失敗 4 輪才會斷訊。
原本每 3 天一次，只要一輪失敗，下一輪已是第 6 天，中間會漏接約一天的推播。

這個 job 不要設定重試（`retryConfig.retryCount` 維持 0）：hub 故障時 `subscribe-all` 會回 502，
隔天的排程就是下一次重試。

## 同時要檢查的其他排程 Job

在這次排查中也發現了其他問題，遷移時請一併檢查：

| 檢查項目 | 說明 |
|----------|------|
| 所有 Cloud Scheduler 目標 URL | 確認指向正確環境（production / staging） |
| `WEBSUB_CALLBACK_URL` 環境變數 | Production 服務必須指向 production callback URL |
| Maintenance clean jobs | 確認清理 job 打的是 production，不是 staging |

## 費用

Cloud Tasks 每月前 100 萬次免費。200~500 頻道每天執行一次 ≈ 每月一萬多次，完全在免費額度內。

真正要注意的是 Cloud Run 的計費時間：每個 `subscribe-one` 佔用 instance 的時間等於它等 hub 回應的時間。
hub 正常時每個頻道不到 1 秒，一輪約幾分鐘。hub 故障時靠派發前探測把整輪擋掉，成本約 15 秒。

## 2026-09 hub 故障事件

- **現象**：2026-09-03T19:00Z 起 `pubsubhubbub.appspot.com/subscribe` 時好時壞，
  故障時每個訂閱請求卡約 20 秒後回 `503 Transient error; please try again later`。
  從 Cloud Run 與從家用網路測試結果相同，是 hub 本身的問題。故障期間單次成功率約 2.5%
- **本專案受到的影響**：每輪 199 個頻道 × 重試 3 次 × 逾時 10 秒 ≈ 1.7 小時計費時間。
  9/15、9/18 兩輪續訂幾乎全失敗，5 天租約到期後，9/18 起 hub 推播從每天 200~350 筆掉到個位數
- **同帳單帳戶的 VTaxon** 佇列吃 Cloud Tasks 預設值（重試 100 次），
  每日計費時間從 0.25 小時變成最高 15.6 小時，是 9 月帳單超出預算的主因
- **事後調整**：佇列重試間隔 10 秒 → 300 秒、排程每 3 天 → 每天、逾時 10 秒 → 5 秒、派發前探測 hub
- **沒有帳單匯出時的查法**：Cloud Monitoring 的
  `run.googleapis.com/container/billable_instance_time` 依 `service_name` 分日彙總找出暴增的服務，
  再用 `gcloud logging read` 過濾 `httpRequest.status>=500` 看是哪個路徑
- **重測 hub 是否恢復又不影響真實訂閱**：送一筆 `hub.callback` 指向自家服務不存在路徑的訂閱請求，
  hub 非同步驗證拿到 404 就會作廢，只看回應碼與耗時即可
