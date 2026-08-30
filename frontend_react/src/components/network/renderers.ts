/**
 * 關係網路的 Canvas 繪製:星空背景、邊、六角形頭像節點、標籤。
 * 六角形節點語彙移植自 VTaxon。
 *
 * 效能設計(千節點規模):
 * - 節點畫面預渲染成 sprite 快取,熱路徑不跑 shadowBlur / clip
 * - 視野裁剪:螢幕外的節點、邊、暈染、標籤一律跳過
 * - 頭像延遲載入:節點實際可見時才發出圖片請求
 * - 漸層(背景、社群暈染)建立一次重複使用
 */

import type { CanvasTransform } from "./GraphCanvas";
import type { GraphLayout, LayoutNode } from "@/types/network";
import { channelInitial } from "./displayName";
import { communityColor } from "./communities";
import { EGO_OUTER_RING } from "./layout";
import {
  FONT_BASE,
  FONT_MIN_SCALE,
  HEX_RADIUS,
  LABEL_GAP_RATIO,
  LINE_HEIGHT_RATIO,
} from "./labelMetrics";
import {
  BG_COLOR,
  BG_CENTER,
  EDGE_ALPHA,
  EDGE_COLOR,
  EDGE_DIM_ALPHA,
  EDGE_HIGHLIGHT_ALPHA,
  FAR_COLOR,
  FAR_GLOW,
  FOCUSED_COLOR,
  FOCUSED_GLOW,
  HOP2_COLOR,
  HOP2_GLOW,
  LABEL_COLOR,
  LABEL_DIM,
  NEIGHBOR_COLOR,
  NEIGHBOR_GLOW,
  NODE_DIM_ALPHA,
} from "./colors";

export { HEX_RADIUS } from "./labelMetrics";
/** 縮放小於此值時節點退化為圓點、不畫標籤(LOD) */
const DOTS_ONLY_SCALE = 0.25;
/** 社群暈染半徑(world px) */
const HALO_RADIUS = 110;
/** 視野裁剪的寬容邊距(world px,涵蓋暈染與標籤外溢) */
const CULL_MARGIN = 160;

export interface RenderState {
  layout: GraphLayout;
  images: Map<string, HTMLImageElement>;
  hoveredId: string | null;
  focusedId: string | null;
  /** 聚焦節點的鄰居 id(邊的亮暗判斷用) */
  highlightIds: Set<string> | null;
  /** 與參考點(選取優先,其次圓心)的跳數:0/1/2;不在表內 = 更遠 */
  hopDistances: Map<string, number> | null;
  starField: { x: number; y: number; r: number; alpha: number }[];
  /** 要求載入頭像(延遲載入);未提供時不載圖 */
  requestImage?: (url: string) => void;
}

export function createStarField(count = 260, spread = 2600) {
  const stars = [];
  for (let i = 0; i < count; i++) {
    stars.push({
      x: (Math.random() - 0.5) * spread,
      y: (Math.random() - 0.5) * spread,
      r: Math.random() * 1.4 + 0.3,
      alpha: Math.random() * 0.5 + 0.1,
    });
  }
  return stars;
}

function hexPath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 2;
    const px = x + r * Math.cos(angle);
    const py = y + r * Math.sin(angle);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

// ── Sprite 快取 ─────────────────────────────────────────

/** sprite 解析度倍率(高 DPI 與放大時維持銳利) */
const SPRITE_SCALE = 2;
/** sprite 內容外擴(光暈用) */
const SPRITE_PAD = 16;
const SPRITE_HALF = HEX_RADIUS + SPRITE_PAD;
// 每個節點最多四種距離色變體,快取上限要涵蓋(節點數 × 變體數)
const MAX_SPRITE_CACHE = 8000;

const nodeSpriteCache = new Map<string, HTMLCanvasElement>();
const haloSpriteCache = new Map<number, HTMLCanvasElement | null>();

function createSpriteCanvas(size: number): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  return canvas.getContext("2d");
}

/** 節點 sprite:光暈 + 六角底 + 頭像(或首字)+ 邊框,一次畫好之後重複 blit */
function getNodeSprite(
  node: LayoutNode,
  color: string,
  glow: string,
  img: HTMLImageElement | undefined,
): HTMLCanvasElement | null {
  const key = `${node.node.channel_id}|${color}|${img ? "img" : "txt"}`;
  const cached = nodeSpriteCache.get(key);
  if (cached) return cached;

  const size = SPRITE_HALF * 2 * SPRITE_SCALE;
  const spriteCtx = createSpriteCanvas(size);
  if (!spriteCtx) return null;

  spriteCtx.scale(SPRITE_SCALE, SPRITE_SCALE);
  spriteCtx.translate(SPRITE_HALF, SPRITE_HALF);
  const r = HEX_RADIUS;

  // 光暈(sprite 生成時付一次 shadowBlur 成本)
  spriteCtx.save();
  spriteCtx.shadowColor = glow;
  spriteCtx.shadowBlur = 12;
  hexPath(spriteCtx, 0, 0, r);
  spriteCtx.fillStyle = BG_CENTER;
  spriteCtx.fill();
  spriteCtx.restore();

  if (img) {
    spriteCtx.save();
    hexPath(spriteCtx, 0, 0, r - 2);
    spriteCtx.clip();
    spriteCtx.drawImage(img, -r, -r, r * 2, r * 2);
    spriteCtx.restore();
  } else {
    hexPath(spriteCtx, 0, 0, r - 2);
    spriteCtx.fillStyle = "rgba(255,255,255,0.06)";
    spriteCtx.fill();
    spriteCtx.fillStyle = LABEL_COLOR;
    spriteCtx.font = `${r * 0.9}px sans-serif`;
    spriteCtx.textAlign = "center";
    spriteCtx.textBaseline = "middle";
    spriteCtx.fillText(channelInitial(node.node), 0, 1);
  }

  hexPath(spriteCtx, 0, 0, r);
  spriteCtx.strokeStyle = color;
  spriteCtx.lineWidth = 2;
  spriteCtx.stroke();

  if (nodeSpriteCache.size >= MAX_SPRITE_CACHE) nodeSpriteCache.clear();
  const canvas = spriteCtx.canvas;
  nodeSpriteCache.set(key, canvas);
  return canvas;
}

/** 標籤 sprite:每個節點的多行標籤渲染一次(最壞情況字級 × 2 倍解析度),之後縮放 blit */
const labelSpriteCache = new Map<string, HTMLCanvasElement | null>();
const LABEL_SPRITE_SCALE = 2;
const LABEL_SPRITE_PAD = 4;

function getLabelSprite(node: LayoutNode): HTMLCanvasElement | null {
  const key = node.node.channel_id;
  const cached = labelSpriteCache.get(key);
  if (cached !== undefined) return cached;

  const worstFont = FONT_BASE / FONT_MIN_SCALE;
  const lineHeight = worstFont * LINE_HEIGHT_RATIO;
  const width = Math.ceil((node.labelHalfWidth * 2 + LABEL_SPRITE_PAD * 2) * LABEL_SPRITE_SCALE);
  const height = Math.ceil(
    (node.labelLines.length * lineHeight + LABEL_SPRITE_PAD * 2) * LABEL_SPRITE_SCALE,
  );

  if (typeof document === "undefined") {
    labelSpriteCache.set(key, null);
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(width, 1);
  canvas.height = Math.max(height, 1);
  const spriteCtx = canvas.getContext("2d");
  if (!spriteCtx) {
    labelSpriteCache.set(key, null);
    return null;
  }

  spriteCtx.scale(LABEL_SPRITE_SCALE, LABEL_SPRITE_SCALE);
  spriteCtx.font = `${worstFont}px sans-serif`;
  spriteCtx.textAlign = "center";
  spriteCtx.textBaseline = "top";
  spriteCtx.fillStyle = LABEL_COLOR;
  node.labelLines.forEach((line, i) => {
    spriteCtx.fillText(
      line,
      node.labelHalfWidth + LABEL_SPRITE_PAD,
      LABEL_SPRITE_PAD + i * lineHeight,
    );
  });

  if (labelSpriteCache.size >= MAX_SPRITE_CACHE) labelSpriteCache.clear();
  labelSpriteCache.set(key, canvas);
  return canvas;
}

/** 社群暈染 sprite:每個社群一張,重複 blit */
function getHaloSprite(community: number): HTMLCanvasElement | null {
  if (haloSpriteCache.has(community)) return haloSpriteCache.get(community)!;
  const size = 128;
  const spriteCtx = createSpriteCanvas(size);
  if (!spriteCtx) {
    haloSpriteCache.set(community, null);
    return null;
  }
  const gradient = spriteCtx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );
  gradient.addColorStop(0, communityColor(community, 0.07));
  gradient.addColorStop(1, communityColor(community, 0));
  spriteCtx.fillStyle = gradient;
  spriteCtx.fillRect(0, 0, size, size);
  haloSpriteCache.set(community, spriteCtx.canvas);
  return spriteCtx.canvas;
}

// ── 背景 ─────────────────────────────────────────────────

let bgGradientKey = "";
let bgGradient: CanvasGradient | null = null;

function drawBackground(
  ctx: CanvasRenderingContext2D,
  transform: CanvasTransform,
  width: number,
  height: number,
  stars: RenderState["starField"],
) {
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, width, height);

  const key = `${width}x${height}`;
  if (key !== bgGradientKey || !bgGradient) {
    bgGradient = ctx.createRadialGradient(
      width / 2,
      height / 2,
      0,
      width / 2,
      height / 2,
      Math.max(width, height) * 0.7,
    );
    bgGradient.addColorStop(0, BG_CENTER);
    bgGradient.addColorStop(1, BG_COLOR);
    bgGradientKey = key;
  }
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, width, height);

  // 星空以低速跟隨平移(視差感),不隨縮放改變大小
  ctx.save();
  ctx.translate(width / 2 + transform.x * 0.3, height / 2 + transform.y * 0.3);
  ctx.fillStyle = "#ffffff";
  for (const s of stars) {
    ctx.globalAlpha = s.alpha;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

/** ego 模式下,節點是否屬於外圍(與圓心兩層內無關)而需淡化 */
function isEgoOuter(state: RenderState, id: string): boolean {
  return state.layout.rings?.get(id) === EGO_OUTER_RING;
}

function nodeVisual(node: LayoutNode, state: RenderState) {
  const id = node.node.channel_id;
  const dim = isEgoOuter(state, id);
  const distance = state.hopDistances?.get(id);
  if (distance === 0) return { color: FOCUSED_COLOR, glow: FOCUSED_GLOW, dim: false };
  if (distance === 1) return { color: NEIGHBOR_COLOR, glow: NEIGHBOR_GLOW, dim };
  if (distance === 2) return { color: HOP2_COLOR, glow: HOP2_GLOW, dim };
  return { color: FAR_COLOR, glow: FAR_GLOW, dim };
}

// ── 開發模式的幀時間量測 ──
let frameTimes: number[] = [];
function recordFrameTime(ms: number) {
  frameTimes.push(ms);
  if (frameTimes.length >= 20) {
    const avg = frameTimes.reduce((s, v) => s + v, 0) / frameTimes.length;
    const max = Math.max(...frameTimes);
    console.log(`[graph-perf] frames=20 avg=${avg.toFixed(1)}ms max=${max.toFixed(1)}ms`);
    frameTimes = [];
  }
}

export function drawNetwork(
  ctx: CanvasRenderingContext2D,
  transform: CanvasTransform,
  sizeWidth: number,
  sizeHeight: number,
  state: RenderState,
) {
  const frameStart = import.meta.env.DEV ? performance.now() : 0;
  const dpr = window.devicePixelRatio || 1;
  const width = sizeWidth / dpr;
  const height = sizeHeight / dpr;

  drawBackground(ctx, transform, width, height, state.starField);

  ctx.save();
  ctx.translate(transform.x, transform.y);
  ctx.scale(transform.scale, transform.scale);

  const { layout } = state;
  const scale = transform.scale;
  const dotsOnly = scale < DOTS_ONLY_SCALE;

  // ── 視野裁剪:世界座標下的可見範圍 ──
  const viewMinX = -transform.x / scale - CULL_MARGIN;
  const viewMinY = -transform.y / scale - CULL_MARGIN;
  const viewMaxX = (width - transform.x) / scale + CULL_MARGIN;
  const viewMaxY = (height - transform.y) / scale + CULL_MARGIN;

  const visible = new Uint8Array(layout.nodes.length);
  layout.nodes.forEach((node, i) => {
    const inView =
      node.x > viewMinX && node.x < viewMaxX && node.y > viewMinY && node.y < viewMaxY;
    visible[i] = inView ? 1 : 0;
  });

  // ── 社群暈染(僅全圖模式;ego 模式的環狀結構自己說話)──
  if (!layout.rings && layout.communities) {
    layout.nodes.forEach((node, i) => {
      if (!visible[i]) return;
      const community = layout.communities!.get(node.node.channel_id);
      if (community === undefined) return;
      const sprite = getHaloSprite(community);
      if (!sprite) return;
      ctx.drawImage(
        sprite,
        node.x - HALO_RADIUS,
        node.y - HALO_RADIUS,
        HALO_RADIUS * 2,
        HALO_RADIUS * 2,
      );
    });
  }

  // ── 邊(輕微弧線;依透明度×線寬分組,聚合成少數路徑一次 stroke)──
  const edgeAlpha = (edgeA: string, edgeB: string): number => {
    let alpha = EDGE_ALPHA;
    if (state.highlightIds !== null) {
      const onFocus =
        state.focusedId !== null && (edgeA === state.focusedId || edgeB === state.focusedId);
      alpha = onFocus ? EDGE_HIGHLIGHT_ALPHA : EDGE_DIM_ALPHA;
    } else if (state.hoveredId && (edgeA === state.hoveredId || edgeB === state.hoveredId)) {
      alpha = EDGE_HIGHLIGHT_ALPHA;
    }
    // ego 模式:任一端在外圍的邊一律淡化
    if (isEgoOuter(state, edgeA) || isEgoOuter(state, edgeB)) {
      alpha = Math.min(alpha, EDGE_DIM_ALPHA);
    }
    return alpha;
  };

  ctx.strokeStyle = EDGE_COLOR;
  const canBatchEdges = typeof Path2D !== "undefined";
  const edgeGroups = canBatchEdges
    ? new Map<string, { alpha: number; width: number; path: Path2D }>()
    : null;

  for (const { edge, source, target } of layout.edges) {
    // 線段外接框不與視野相交 → 跳過
    if (
      Math.max(source.x, target.x) < viewMinX ||
      Math.min(source.x, target.x) > viewMaxX ||
      Math.max(source.y, target.y) < viewMinY ||
      Math.min(source.y, target.y) > viewMaxY
    ) {
      continue;
    }

    const alpha = edgeAlpha(edge.a, edge.b);
    const width = Math.min(1 + edge.evidence_count * 0.6, 5);

    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const length = Math.hypot(dx, dy) || 1;
    const bow = Math.min(length * 0.1, 36);
    const controlX = (source.x + target.x) / 2 - (dy / length) * bow;
    const controlY = (source.y + target.y) / 2 + (dx / length) * bow;

    if (edgeGroups) {
      const widthBucket = Math.round(width * 2) / 2;
      const key = `${alpha}|${widthBucket}`;
      let group = edgeGroups.get(key);
      if (!group) {
        group = { alpha, width: widthBucket, path: new Path2D() };
        edgeGroups.set(key, group);
      }
      group.path.moveTo(source.x, source.y);
      group.path.quadraticCurveTo(controlX, controlY, target.x, target.y);
    } else {
      // fallback(測試環境等):逐邊繪製
      ctx.globalAlpha = alpha;
      ctx.lineWidth = width / scale;
      ctx.beginPath();
      ctx.moveTo(source.x, source.y);
      ctx.quadraticCurveTo(controlX, controlY, target.x, target.y);
      ctx.stroke();
    }
  }

  if (edgeGroups) {
    for (const group of edgeGroups.values()) {
      ctx.globalAlpha = group.alpha;
      ctx.lineWidth = group.width / scale;
      ctx.stroke(group.path);
    }
  }
  ctx.globalAlpha = 1;

  // ── 節點 ──
  layout.nodes.forEach((node, i) => {
    if (!visible[i]) return;
    const { color, glow, dim } = nodeVisual(node, state);
    const hovered = state.hoveredId === node.node.channel_id;
    ctx.globalAlpha = dim && !hovered ? NODE_DIM_ALPHA : 1;

    if (dotsOnly) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(node.x, node.y, 6 / Math.max(scale, 0.08), 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    // 頭像延遲載入:實際可見才發請求
    let img: HTMLImageElement | undefined;
    if (node.node.thumbnail) {
      img = state.images.get(node.node.thumbnail);
      if (!img) state.requestImage?.(node.node.thumbnail);
    }

    const sprite = getNodeSprite(node, color, glow, img);
    if (sprite) {
      ctx.drawImage(
        sprite,
        node.x - SPRITE_HALF,
        node.y - SPRITE_HALF,
        SPRITE_HALF * 2,
        SPRITE_HALF * 2,
      );
    } else {
      // 無法建立 sprite(測試環境等):直接繪製
      const r = HEX_RADIUS;
      hexPath(ctx, node.x, node.y, r - 2);
      ctx.fillStyle = BG_CENTER;
      ctx.fill();
      ctx.fillStyle = LABEL_COLOR;
      ctx.font = `${r * 0.9}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(channelInitial(node.node), node.x, node.y + 1);
      hexPath(ctx, node.x, node.y, r);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // hover 強調:外圈加粗邊框(單一節點,成本可忽略)
    if (hovered) {
      hexPath(ctx, node.x, node.y, HEX_RADIUS + 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  });
  ctx.globalAlpha = 1;

  // ── 標籤(固定在節點下方置中;layout 已保證互不重疊)──
  if (!dotsOnly) {
    drawLabels(ctx, scale, state, visible);
  }
  ctx.restore();

  if (import.meta.env.DEV) {
    recordFrameTime(performance.now() - frameStart);
  }
}

function drawLabels(
  ctx: CanvasRenderingContext2D,
  scale: number,
  state: RenderState,
  visible: Uint8Array,
) {
  // scale >= FONT_MIN_SCALE 時螢幕字級恆定,更小時字跟著世界縮小(空間已按最壞情況保留)
  const fontSize = FONT_BASE / Math.max(scale, FONT_MIN_SCALE);
  const lineHeight = fontSize * LINE_HEIGHT_RATIO;
  const worstFont = FONT_BASE / FONT_MIN_SCALE;
  // sprite 以最壞情況字級渲染,依目前字級等比縮小
  const ratio = fontSize / worstFont;
  let fontSet = false;

  state.layout.nodes.forEach((node, i) => {
    if (!visible[i]) return;
    const hovered = state.hoveredId === node.node.channel_id;
    const { dim } = nodeVisual(node, state);
    const startY = node.y + HEX_RADIUS + fontSize * LABEL_GAP_RATIO;

    const sprite = getLabelSprite(node);
    if (sprite) {
      ctx.globalAlpha = dim && !hovered ? 0.4 : 1;
      const destW = (sprite.width / LABEL_SPRITE_SCALE) * ratio;
      const destH = (sprite.height / LABEL_SPRITE_SCALE) * ratio;
      ctx.drawImage(
        sprite,
        node.x - destW / 2,
        startY - LABEL_SPRITE_PAD * ratio,
        destW,
        destH,
      );
      return;
    }

    // fallback(測試環境等):直接 fillText
    if (!fontSet) {
      ctx.font = `${fontSize}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      fontSet = true;
    }
    ctx.fillStyle = dim && !hovered ? LABEL_DIM : LABEL_COLOR;
    node.labelLines.forEach((line, lineIndex) => {
      ctx.fillText(line, node.x, startY + lineIndex * lineHeight);
    });
  });
  ctx.globalAlpha = 1;
}

/** 命中測試:回傳座標下的節點(六角形以外接圓近似) */
export function hitTest(layout: GraphLayout, worldX: number, worldY: number): LayoutNode | null {
  const r2 = (HEX_RADIUS + 4) ** 2;
  // 由後往前(繪製順序上層優先)
  for (let i = layout.nodes.length - 1; i >= 0; i--) {
    const n = layout.nodes[i];
    const dx = n.x - worldX;
    const dy = n.y - worldY;
    if (dx * dx + dy * dy <= r2) return n;
  }
  return null;
}
