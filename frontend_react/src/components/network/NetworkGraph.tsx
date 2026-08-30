/**
 * 關係網路圖主元件:layout 計算、hover/聚焦互動、相機控制。
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import GraphCanvas, { type GraphCanvasHandle, type CanvasTransform } from "./GraphCanvas";
import { computeLayout, EGO_OUTER_RING } from "./layout";
import { HEX_RADIUS } from "./labelMetrics";
import { createStarField, drawNetwork, hitTest, type RenderState } from "./renderers";
import { useImageCache } from "./useImageCache";
import type { NetworkGraphData } from "@/types/network";

/** ego 取景的縮放下限:低於此值節點會退化成圓點、標籤也不畫 */
const EGO_MIN_SCALE = 0.5;

interface NetworkGraphProps {
  data: NetworkGraphData;
  focusedId: string | null;
  /** ego 模式的圓心;null = 一般全圖 */
  egoCenterId: string | null;
  onFocusChange: (channelId: string | null) => void;
  /** 聚焦時側板佔用的右側寬度(px),相機置中時避開 */
  panelInset?: number;
}

export interface NetworkGraphHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  fitAll: () => void;
  /** 相機移到指定頻道(不存在時無動作),回傳是否找到 */
  panToNode: (channelId: string) => boolean;
}

const NetworkGraph = forwardRef<NetworkGraphHandle, NetworkGraphProps>(function NetworkGraph(
  { data, focusedId, egoCenterId, onFocusChange, panelInset = 0 },
  ref,
) {
  const canvasRef = useRef<GraphCanvasHandle | null>(null);
  const hoveredIdRef = useRef<string | null>(null);

  const layout = useMemo(
    () => computeLayout(data, undefined, egoCenterId ? { centerId: egoCenterId } : undefined),
    [data, egoCenterId],
  );
  const starField = useMemo(() => createStarField(), []);

  const { cacheRef: imagesRef, requestImage } = useImageCache(
    useCallback(() => canvasRef.current?.requestRender(), []),
  );

  const focusedIdRef = useRef(focusedId);
  useEffect(() => {
    focusedIdRef.current = focusedId;
  }, [focusedId]);

  // 外框顏色的參考點:目前選取優先,其次圓心;BFS 兩層跳數
  const referenceId = focusedId ?? egoCenterId;
  const hopDistances = useMemo(() => {
    if (!referenceId || !layout.byId.has(referenceId)) return null;
    const distances = new Map<string, number>([[referenceId, 0]]);
    let frontier = [referenceId];
    for (let hop = 1; hop <= 2; hop++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const neighbor of layout.neighbors.get(id) ?? []) {
          if (!distances.has(neighbor)) {
            distances.set(neighbor, hop);
            next.push(neighbor);
          }
        }
      }
      frontier = next;
    }
    return distances;
  }, [layout, referenceId]);

  const onRender = useCallback(
    (ctx: CanvasRenderingContext2D, transform: CanvasTransform, size: { width: number; height: number }) => {
      const focused = focusedIdRef.current;
      const state: RenderState = {
        layout,
        images: imagesRef.current,
        hoveredId: hoveredIdRef.current,
        focusedId: focused,
        highlightIds: focused ? (layout.neighbors.get(focused) ?? new Set()) : null,
        hopDistances,
        starField,
        requestImage,
        requestRepaint: () => canvasRef.current?.requestRender(),
      };
      drawNetwork(ctx, transform, size.width, size.height, state);
    },
    [layout, hopDistances, starField, imagesRef, requestImage],
  );

  const onHover = useCallback(
    (x: number, y: number, event: MouseEvent) => {
      const hit = hitTest(layout, x, y);
      const id = hit?.node.channel_id ?? null;
      if (id !== hoveredIdRef.current) {
        hoveredIdRef.current = id;
        (event.target as HTMLCanvasElement).style.cursor = id ? "pointer" : "grab";
        canvasRef.current?.requestRender();
      }
    },
    [layout],
  );

  const onClick = useCallback(
    (x: number, y: number) => {
      const hit = hitTest(layout, x, y);
      onFocusChange(hit ? hit.node.channel_id : null);
    },
    [layout, onFocusChange],
  );

  // dev 專用 benchmark 模式:?benchmark=1 時飛到最大 hub(完整細節縮放),連續重繪量測穩態幀時間
  const benchArmed = useRef(false);
  useEffect(() => {
    if (!import.meta.env.DEV || benchArmed.current || !layout.nodes.length) return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has("benchmark")) return;
    benchArmed.current = true;
    let running = true;
    const loop = () => {
      if (!running) return;
      canvasRef.current?.requestRender();
      requestAnimationFrame(loop);
    };
    const timer = setTimeout(() => {
      let hub = layout.nodes[0];
      let bestDegree = -1;
      for (const n of layout.nodes) {
        const degree = layout.neighbors.get(n.node.channel_id)?.size ?? 0;
        if (degree > bestDegree) {
          bestDegree = degree;
          hub = n;
        }
      }
      canvasRef.current?.panTo(hub.x, hub.y, Number(params.get("benchzoom")) || 1);
      setTimeout(() => requestAnimationFrame(loop), 1500);
    }, 5000);
    return () => {
      benchArmed.current = false;
      running = false;
      clearTimeout(timer);
    };
  }, [layout]);

  // 初次載入:fit 全圖(ego 模式進頁由下方的圓心取景效果負責,不在這裡搶相機)
  const didInitialFit = useRef(false);
  useEffect(() => {
    if (didInitialFit.current || !layout.nodes.length) return;
    didInitialFit.current = true;
    if (layout.egoCenterId) return;
    const { minX, minY, maxX, maxY } = layout.bounds;
    // 等 canvas 完成第一次 resize
    requestAnimationFrame(() => canvasRef.current?.fitBounds(minX, minY, maxX, maxY));
  }, [layout]);

  // 每次 layout 更新(含資料背景刷新)都確保縮放下限容得下整張圖,
  // 不依賴 fitBounds 是否被呼叫(修正:SPA 導頁進來時下限沒放寬的問題)
  useEffect(() => {
    if (!layout.nodes.length) return;
    const { minX, minY, maxX, maxY } = layout.bounds;
    requestAnimationFrame(() =>
      canvasRef.current?.ensureBoundsZoomable(minX, minY, maxX, maxY),
    );
  }, [layout]);

  // ego 圓心切換:相機取景以圓心為正中心,範圍取到最遠的直接關係人。
  // 位置是力導向的有機佈局,間接關係散佈範圍常常接近整張圖,納入取景
  // 會把視野拉到最遠、什麼都看不清,所以只看第一層;第一層也可能很遠
  // (極端:唯一的關係人在圖的另一頭),所以再守一個可讀的縮放下限。
  const prevEgoRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevEgoRef.current === egoCenterId) return;
    prevEgoRef.current = egoCenterId;
    if (!layout.nodes.length) return;

    const center = egoCenterId ? layout.byId.get(egoCenterId) : null;
    if (!center) return;

    // 以圓心為原點的對稱半徑,確保圓心落在畫面正中
    let halfW = 0;
    let halfH = 0;
    for (const n of layout.nodes) {
      if ((layout.rings?.get(n.node.channel_id) ?? EGO_OUTER_RING) >= 2) continue;
      halfW = Math.max(halfW, Math.abs(n.x - center.x) + n.labelHalfWidth);
      halfH = Math.max(
        halfH,
        Math.abs(n.y - center.y) + Math.max(HEX_RADIUS, n.labelBottomHeight),
      );
    }
    // 沒有任何直接關係人時給一個最小視野,不要無限放大
    halfW = Math.max(halfW, 200);
    halfH = Math.max(halfH, 200);

    requestAnimationFrame(() =>
      canvasRef.current?.fitBounds(
        center.x - halfW,
        center.y - halfH,
        center.x + halfW,
        center.y + halfH,
        80,
        0,
        { minScale: EGO_MIN_SCALE, focusX: center.x, focusY: center.y },
      ),
    );
  }, [egoCenterId, layout]);

  // 聚焦變化:相機移過去 + 重繪
  useEffect(() => {
    canvasRef.current?.requestRender();
    if (!focusedId) return;
    const node = layout.byId.get(focusedId);
    if (!node) return;
    const scale = Math.max(canvasRef.current?.getTransform().scale ?? 1, 0.9);
    canvasRef.current?.panTo(node.x, node.y, scale, panelInset);
  }, [focusedId, layout, panelInset]);

  useImperativeHandle(
    ref,
    () => ({
      zoomIn: () => canvasRef.current?.zoomIn(),
      zoomOut: () => canvasRef.current?.zoomOut(),
      fitAll: () => {
        const { minX, minY, maxX, maxY } = layout.bounds;
        canvasRef.current?.fitBounds(minX, minY, maxX, maxY);
      },
      panToNode: (channelId: string) => {
        const node = layout.byId.get(channelId);
        if (!node) return false;
        const scale = Math.max(canvasRef.current?.getTransform().scale ?? 1, 0.9);
        canvasRef.current?.panTo(node.x, node.y, scale, panelInset);
        return true;
      },
    }),
    [layout, panelInset],
  );

  return <GraphCanvas ref={canvasRef} onRender={onRender} onHover={onHover} onClick={onClick} />;
});

export default NetworkGraph;
