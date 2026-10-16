# services/live_redirect/youtube_api.py

import logging
import os

import requests
from requests.exceptions import RequestException

from utils.breaker_instances import youtube_breaker
from utils.circuit_breaker import circuit_breaker
from utils.retry import retry_on_transient_error

YOUTUBE_API_URL = "https://www.googleapis.com/youtube/v3/videos"


def _get_api_key() -> str:
    return os.getenv("API_KEY", "")


@circuit_breaker(youtube_breaker)
@retry_on_transient_error(max_retries=3, base_delay=1.0)
def _fetch_with_retry(params: dict) -> list[dict]:
    """帶 retry + 熔斷保護的 YouTube API 請求"""
    resp = requests.get(YOUTUBE_API_URL, params=params, timeout=10)
    resp.raise_for_status()
    return resp.json().get("items", [])  # type: ignore[no-any-return]


DEFAULT_PARTS = "snippet,liveStreamingDetails,status"


def batch_fetch_video_details(video_ids: list[str], parts: str = DEFAULT_PARTS) -> list[dict]:
    api_key = _get_api_key()
    if not api_key:
        logging.error("❌ 環境變數 API_KEY 未設定")
        return []

    results = []

    for i in range(0, len(video_ids), 50):
        batch = video_ids[i : i + 50]
        params = {
            "part": parts,
            "id": ",".join(batch),
            "key": api_key,
        }

        try:
            logging.info(f"🌐 查詢 YouTube API：{batch}")
            items = _fetch_with_retry(params)
            results.extend(items)
            logging.info(f"📦 成功取得 {len(items)} 筆影片資訊")
        except RequestException as e:
            logging.warning(f"⚠️ 查詢失敗：{e}")

    return results
