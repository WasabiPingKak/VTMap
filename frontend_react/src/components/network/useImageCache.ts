/** 頭像圖片延遲載入快取:渲染器對「實際可見」的節點呼叫 requestImage,
 * 載入完成後通知重繪。避免一次抓上千張看不到的頭像。 */

import { useCallback, useEffect, useRef } from "react";

export function useImageCache(onLoaded: () => void) {
  const cacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const pendingRef = useRef<Set<string>>(new Set());
  const onLoadedRef = useRef(onLoaded);
  useEffect(() => {
    onLoadedRef.current = onLoaded;
  }, [onLoaded]);

  const requestImage = useCallback((url: string) => {
    if (cacheRef.current.has(url) || pendingRef.current.has(url)) return;
    pendingRef.current.add(url);

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      cacheRef.current.set(url, img);
      pendingRef.current.delete(url);
      onLoadedRef.current();
    };
    img.onerror = () => {
      // CORS 或載入失敗:改用無 crossOrigin 再試一次(canvas 仍可繪製)
      const fallback = new Image();
      fallback.onload = () => {
        cacheRef.current.set(url, fallback);
        pendingRef.current.delete(url);
        onLoadedRef.current();
      };
      fallback.onerror = () => pendingRef.current.delete(url);
      fallback.src = url;
    };
    img.src = url;
  }, []);

  return { cacheRef, requestImage };
}
