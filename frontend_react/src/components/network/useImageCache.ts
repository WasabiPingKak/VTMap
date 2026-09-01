/** 頭像圖片延遲載入快取:渲染器對「實際可見」的節點呼叫 requestImage,
 * 載入完成後通知重繪。避免一次抓上千張看不到的頭像。 */

import { useCallback, useEffect, useRef } from "react";

export function useImageCache(onLoaded: () => void) {
  const cacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const pendingRef = useRef<Set<string>>(new Set());
  // pending 中的 Image instances,元件卸載時要 abort(否則 onload 仍會塞資料到已被丟棄的 Map)
  const pendingImagesRef = useRef<Set<HTMLImageElement>>(new Set());
  // 卸載後不再處理 load callback,避免 setState/requestRender 打到已卸載元件
  const mountedRef = useRef(true);
  const onLoadedRef = useRef(onLoaded);
  useEffect(() => {
    onLoadedRef.current = onLoaded;
  }, [onLoaded]);

  useEffect(() => {
    // 在 effect setup 就取 ref(Set 是可變參考,cleanup 時仍指向同一物件),
    // 避開 react-hooks/exhaustive-deps 對「cleanup 讀 ref.current」的警告
    const pendingImages = pendingImagesRef.current;
    const pending = pendingRef.current;
    return () => {
      mountedRef.current = false;
      // 中斷所有 pending 下載:null 掉 handlers + 清空 src,瀏覽器就會取消底層請求
      for (const img of pendingImages) {
        img.onload = null;
        img.onerror = null;
        img.src = "";
      }
      pendingImages.clear();
      pending.clear();
    };
  }, []);

  const requestImage = useCallback((url: string) => {
    if (cacheRef.current.has(url) || pendingRef.current.has(url)) return;
    pendingRef.current.add(url);

    const img = new Image();
    img.crossOrigin = "anonymous";
    pendingImagesRef.current.add(img);
    img.onload = () => {
      pendingImagesRef.current.delete(img);
      if (!mountedRef.current) return;
      cacheRef.current.set(url, img);
      pendingRef.current.delete(url);
      onLoadedRef.current();
    };
    img.onerror = () => {
      pendingImagesRef.current.delete(img);
      if (!mountedRef.current) return;
      // CORS 或載入失敗:改用無 crossOrigin 再試一次(canvas 仍可繪製)
      const fallback = new Image();
      pendingImagesRef.current.add(fallback);
      fallback.onload = () => {
        pendingImagesRef.current.delete(fallback);
        if (!mountedRef.current) return;
        cacheRef.current.set(url, fallback);
        pendingRef.current.delete(url);
        onLoadedRef.current();
      };
      fallback.onerror = () => {
        pendingImagesRef.current.delete(fallback);
        if (!mountedRef.current) return;
        pendingRef.current.delete(url);
      };
      fallback.src = url;
    };
    img.src = url;
  }, []);

  return { cacheRef, requestImage };
}
