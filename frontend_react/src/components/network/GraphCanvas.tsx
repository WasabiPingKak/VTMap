/**
 * 通用畫布元件:Canvas 2D + d3-zoom 平移縮放(移植自 VTaxon GraphCanvas)。
 * 繪製全部委派給 onRender callback,自身只管 zoom/resize/DPR/座標轉換。
 */

import {
  useEffect,
  useRef,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from "react";
import { select } from "d3-selection";
import {
  zoom as d3zoom,
  zoomIdentity,
  type ZoomBehavior,
  type ZoomTransform,
} from "d3-zoom";
import "d3-transition"; // side-effect import — 讓 Selection 支援 .transition()

/** 滾輪縮放靈敏度倍率(相對 d3 預設):2.5 → 每格約 1.41 倍 */
const WHEEL_ZOOM_FACTOR = 2.5;

export interface CanvasTransform {
  x: number;
  y: number;
  scale: number;
}

interface CanvasSize {
  width: number;
  height: number;
}

type RenderCallback = (
  ctx: CanvasRenderingContext2D,
  transform: CanvasTransform,
  size: CanvasSize,
) => void;

type PointCallback = (worldX: number, worldY: number, event: MouseEvent) => void;

interface GraphCanvasProps {
  onRender?: RenderCallback;
  onHover?: PointCallback;
  onHoverLeave?: () => void;
  onClick?: PointCallback;
  minZoom?: number;
  maxZoom?: number;
}

export interface GraphCanvasHandle {
  requestRender: () => void;
  getTransform: () => CanvasTransform;
  /** canvas 是否已被排版量測完成(size > 0);fitBounds/panTo 需要 size 才能算 */
  isReady: () => boolean;
  zoomIn: () => void;
  zoomOut: () => void;
  panTo: (worldX: number, worldY: number, scale?: number | null, rightInset?: number) => void;
  fitBounds: (
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    padding?: number,
    rightInset?: number,
  ) => void;
}

const GraphCanvas = forwardRef<GraphCanvasHandle, GraphCanvasProps>(function GraphCanvas(
  { onRender, onHover, onHoverLeave, onClick, minZoom = 0.05, maxZoom = 4 },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const transformRef = useRef<CanvasTransform>({ x: 0, y: 0, scale: 1 });
  const zoomRef = useRef<ZoomBehavior<HTMLCanvasElement, unknown> | null>(null);
  const rafRef = useRef<number | null>(null);
  const sizeRef = useRef<CanvasSize>({ width: 0, height: 0 });
  // 縮放下限會依圖的實際大小自動放寬(見 fitBounds)
  const dynamicMinZoomRef = useRef(minZoom);

  // callback 走 ref,避免 RAF 內的 stale closure(在 effect 中更新以符合 hooks 規範)
  const onRenderRef = useRef(onRender);
  const onHoverRef = useRef(onHover);
  const onHoverLeaveRef = useRef(onHoverLeave);
  const onClickRef = useRef(onClick);
  useEffect(() => {
    onRenderRef.current = onRender;
    onHoverRef.current = onHover;
    onHoverLeaveRef.current = onHoverLeave;
    onClickRef.current = onClick;
  }, [onRender, onHover, onHoverLeave, onClick]);

  const requestRender = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      onRenderRef.current?.(ctx, transformRef.current, sizeRef.current);
    });
  }, []);

  const screenToWorld = useCallback((screenX: number, screenY: number) => {
    const t = transformRef.current;
    return { x: (screenX - t.x) / t.scale, y: (screenY - t.y) / t.scale };
  }, []);

  useEffect(() => {
    requestRender();
  }, [onRender, requestRender]);

  // resize + DPR
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !canvas.parentElement) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.parentElement!.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      sizeRef.current = { width: rect.width * dpr, height: rect.height * dpr };
      requestRender();
    };

    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement);
    resize();
    return () => ro.disconnect();
  }, [requestRender]);

  // d3-zoom
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const zoomBehavior = d3zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([Math.min(minZoom, dynamicMinZoomRef.current), maxZoom])
      // 滾輪縮放靈敏度:d3 預設每格約 1.15 倍(全景到 1:1 要滾約 17 格,太慢)。
      // 乘上 WHEEL_ZOOM_FACTOR 後每格約 1.41 倍(7 格),與 +/- 按鈕的 1.4 一致。
      // 嫌快就調小、嫌慢就調大,只動這一個數字。
      .wheelDelta(
        (event: WheelEvent) =>
          -event.deltaY *
          (event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002) *
          WHEEL_ZOOM_FACTOR *
          (event.ctrlKey ? 10 : 1),
      )
      .on("zoom", (event) => {
        const t: ZoomTransform = event.transform;
        transformRef.current = { x: t.x, y: t.y, scale: t.k };
        requestRender();
      });

    zoomRef.current = zoomBehavior;
    const sel = select(canvas);
    sel.call(zoomBehavior as unknown as Parameters<typeof sel.call>[0]);

    const preventContext = (e: Event) => e.preventDefault();
    canvas.addEventListener("contextmenu", preventContext);
    return () => {
      sel.on(".zoom", null);
      canvas.removeEventListener("contextmenu", preventContext);
    };
  }, [minZoom, maxZoom, requestRender]);

  // hover / click
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const toWorld = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      return screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    };

    // mousemove 用 rAF 節流:同一幀內只處理最後一次事件,
    // 避免高頻 mousemove(120Hz+)每次都觸發 hitTest+重繪
    let pendingMove: MouseEvent | null = null;
    let moveRafId: number | null = null;
    const flushMove = () => {
      moveRafId = null;
      const e = pendingMove;
      pendingMove = null;
      if (!e) return;
      const w = toWorld(e);
      onHoverRef.current?.(w.x, w.y, e);
    };
    const moveHandler = (e: MouseEvent) => {
      pendingMove = e;
      if (moveRafId !== null) return;
      moveRafId = requestAnimationFrame(flushMove);
    };
    const clickHandler = (e: MouseEvent) => {
      const w = toWorld(e);
      onClickRef.current?.(w.x, w.y, e);
    };

    const leaveHandler = () => {
      pendingMove = null;
      if (moveRafId !== null) {
        cancelAnimationFrame(moveRafId);
        moveRafId = null;
      }
      onHoverLeaveRef.current?.();
    };
    canvas.addEventListener("mousemove", moveHandler);
    canvas.addEventListener("mouseleave", leaveHandler);
    canvas.addEventListener("click", clickHandler);
    return () => {
      if (moveRafId !== null) cancelAnimationFrame(moveRafId);
      canvas.removeEventListener("mousemove", moveHandler);
      canvas.removeEventListener("mouseleave", leaveHandler);
      canvas.removeEventListener("click", clickHandler);
    };
  }, [screenToWorld]);

  useImperativeHandle(
    ref,
    () => ({
      requestRender,
      getTransform: () => transformRef.current,
      isReady: () => sizeRef.current.width > 0 && sizeRef.current.height > 0,

      zoomIn() {
        const canvas = canvasRef.current;
        if (!canvas || !zoomRef.current) return;
        const sel = select(canvas);
        sel.interrupt();
        sel
          .transition()
          .duration(300)
          .call(
            zoomRef.current.scaleBy as unknown as Parameters<
              ReturnType<typeof sel.transition>["call"]
            >[0],
            1.4,
          );
      },

      zoomOut() {
        const canvas = canvasRef.current;
        if (!canvas || !zoomRef.current) return;
        const sel = select(canvas);
        sel.interrupt();
        sel
          .transition()
          .duration(300)
          .call(
            zoomRef.current.scaleBy as unknown as Parameters<
              ReturnType<typeof sel.transition>["call"]
            >[0],
            1 / 1.4,
          );
      },

      panTo(worldX, worldY, scale = null, rightInset = 0) {
        const canvas = canvasRef.current;
        if (!canvas || !zoomRef.current) return;
        const dpr = window.devicePixelRatio || 1;
        const w = sizeRef.current.width / dpr;
        const h = sizeRef.current.height / dpr;
        const s = scale ?? transformRef.current.scale;
        const cx = (w - rightInset) / 2;
        const cy = h / 2;

        const sel = select(canvas);
        sel.interrupt();
        sel
          .transition()
          .duration(600)
          .call(
            zoomRef.current.transform as unknown as Parameters<
              ReturnType<typeof sel.transition>["call"]
            >[0],
            zoomIdentity.translate(cx - worldX * s, cy - worldY * s).scale(s),
          );
      },

      fitBounds(minX, minY, maxX, maxY, padding = 80, rightInset = 0) {
        const canvas = canvasRef.current;
        if (!canvas || !zoomRef.current) return;
        const dpr = window.devicePixelRatio || 1;
        const w = sizeRef.current.width / dpr;
        const h = sizeRef.current.height / dpr;
        // canvas 還沒被排版量測(size=0)時,強制 fit 會算出 targetScale=0、
        // 把 scaleExtent 設成 [0, 4] 卡住 d3-zoom;直接 no-op,呼叫端 rAF 重試即可
        if (w <= 0 || h <= 0) return;

        const availW = w - rightInset;
        const boundsW = maxX - minX + padding * 2;
        const boundsH = maxY - minY + padding * 2;
        const targetScale = Math.min(availW / boundsW, h / boundsH, 1.5);

        // 圖比縮放下限還大時,自動放寬下限(留一半餘裕),保證全圖永遠裝得下、也縮得出去
        if (targetScale < dynamicMinZoomRef.current) {
          dynamicMinZoomRef.current = targetScale * 0.5;
          zoomRef.current.scaleExtent([dynamicMinZoomRef.current, maxZoom]);
        }

        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const tx = availW / 2 - cx * targetScale;
        const ty = h / 2 - cy * targetScale;

        const sel = select(canvas);
        sel.interrupt();
        sel
          .transition()
          .duration(700)
          .call(
            zoomRef.current.transform as unknown as Parameters<
              ReturnType<typeof sel.transition>["call"]
            >[0],
            zoomIdentity.translate(tx, ty).scale(targetScale),
          );
      },
    }),
    [requestRender, maxZoom],
  );

  return (
    <canvas
      ref={canvasRef}
      style={{ display: "block", width: "100%", height: "100%", cursor: "grab" }}
    />
  );
});

export default GraphCanvas;
