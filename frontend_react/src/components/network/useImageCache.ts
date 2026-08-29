/** 頭像圖片載入快取:載入完成時通知重繪。 */

import { useEffect, useRef } from "react";

export function useImageCache(urls: (string | null)[], onLoaded: () => void) {
  const cacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const onLoadedRef = useRef(onLoaded);
  useEffect(() => {
    onLoadedRef.current = onLoaded;
  }, [onLoaded]);

  useEffect(() => {
    const cache = cacheRef.current;
    for (const url of urls) {
      if (!url || cache.has(url)) continue;
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        cache.set(url, img);
        onLoadedRef.current();
      };
      img.onerror = () => {
        // CORS 或載入失敗:改用無 crossOrigin 再試一次(canvas 仍可繪製)
        const fallback = new Image();
        fallback.onload = () => {
          cache.set(url, fallback);
          onLoadedRef.current();
        };
        fallback.src = url;
      };
      img.src = url;
    }
  }, [urls]);

  return cacheRef;
}
