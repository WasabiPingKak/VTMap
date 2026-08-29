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
import { computeLayout } from "./layout";
import { createStarField, drawNetwork, hitTest, type RenderState } from "./renderers";
import { useImageCache } from "./useImageCache";
import type { NetworkGraphData } from "@/types/network";

interface NetworkGraphProps {
  data: NetworkGraphData;
  focusedId: string | null;
  onFocusChange: (channelId: string | null) => void;
  /** 聚焦時側板佔用的右側寬度(px),相機置中時避開 */
  panelInset?: number;
}

export interface NetworkGraphHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  fitAll: () => void;
}

const NetworkGraph = forwardRef<NetworkGraphHandle, NetworkGraphProps>(function NetworkGraph(
  { data, focusedId, onFocusChange, panelInset = 0 },
  ref,
) {
  const canvasRef = useRef<GraphCanvasHandle | null>(null);
  const hoveredIdRef = useRef<string | null>(null);

  const layout = useMemo(() => computeLayout(data), [data]);
  const starField = useMemo(() => createStarField(), []);

  const thumbnails = useMemo(() => layout.nodes.map((n) => n.node.thumbnail), [layout]);
  const imagesRef = useImageCache(
    thumbnails,
    useCallback(() => canvasRef.current?.requestRender(), []),
  );

  const focusedIdRef = useRef(focusedId);
  useEffect(() => {
    focusedIdRef.current = focusedId;
  }, [focusedId]);

  const onRender = useCallback(
    (ctx: CanvasRenderingContext2D, transform: CanvasTransform, size: { width: number; height: number }) => {
      const focused = focusedIdRef.current;
      const state: RenderState = {
        layout,
        images: imagesRef.current,
        hoveredId: hoveredIdRef.current,
        focusedId: focused,
        highlightIds: focused ? (layout.neighbors.get(focused) ?? new Set()) : null,
        starField,
      };
      drawNetwork(ctx, transform, size.width, size.height, state);
    },
    [layout, starField, imagesRef],
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

  // 初次載入:fit 全圖
  const didInitialFit = useRef(false);
  useEffect(() => {
    if (didInitialFit.current || !layout.nodes.length) return;
    didInitialFit.current = true;
    const { minX, minY, maxX, maxY } = layout.bounds;
    // 等 canvas 完成第一次 resize
    requestAnimationFrame(() => canvasRef.current?.fitBounds(minX, minY, maxX, maxY));
  }, [layout]);

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
    }),
    [layout],
  );

  return <GraphCanvas ref={canvasRef} onRender={onRender} onHover={onHover} onClick={onClick} />;
});

export default NetworkGraph;
