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
import { EGO_OUTER_RING, packHitCell } from "./layout";
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
  /** sprite 生成限額用盡時要求下一幀重繪(漸進補齊) */
  requestRepaint?: () => void;
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
  addHexToPath(ctx, x, y, r);
}

/** 同 hexPath 但不 beginPath,可累加到 Path2D 做批次描邊 */
function addHexToPath(
  target: CanvasRenderingContext2D | Path2D,
  x: number,
  y: number,
  r: number,
) {
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 2;
    const px = x + r * Math.cos(angle);
    const py = y + r * Math.sin(angle);
    if (i === 0) target.moveTo(px, py);
    else target.lineTo(px, py);
  }
  target.closePath();
}

// ── Sprite 快取 ─────────────────────────────────────────

/** sprite 解析度倍率(高 DPI 與放大時維持銳利) */
const SPRITE_SCALE = 2;
/** sprite 內容外擴(光暈用) */
const SPRITE_PAD = 16;

/** sprite 解析度桶(高→低;縮小檢視時用低解析來源,避免瀏覽器 bilinear 重採樣) */
const SPRITE_BUCKETS = [1, 0.5, 0.25] as const;

/**
 * 依有效縮放(css scale × dpr)選解析度桶:
 * 選最大的「仍小於有效縮放」的桶,降採樣比落在 1~2 倍之間。
 * 千節點全景不卡的關鍵 = 讓瀏覽器每幀不用把 152px sprite 縮到 20px。
 */
function spriteBucketFor(effectiveScale: number): number {
  let bucket = 1;
  while (bucket > 0.25 && bucket >= effectiveScale) bucket /= 2;
  return bucket;
}

/** 每幀允許新建的節點/標籤 sprite 數(獨立額度,避免節點吃光讓標籤退化 fallback) */
const NODE_SPRITE_BUDGET_PER_FRAME = 48;
const LABEL_SPRITE_BUDGET_PER_FRAME = 48;
let nodeSpriteBudget = NODE_SPRITE_BUDGET_PER_FRAME;
let labelSpriteBudget = LABEL_SPRITE_BUDGET_PER_FRAME;
let spriteBudgetExhausted = false;
const SPRITE_HALF = HEX_RADIUS + SPRITE_PAD;
// 每節點的 sprite 變體:有/無頭像 × 3 解析度桶,乘上節點數 → 5000 有餘裕
const MAX_SPRITE_CACHE = 6000;

const nodeSpriteCache = new Map<string, HTMLCanvasElement>();
const glowSpriteCache = new Map<string, HTMLCanvasElement | null>();
const haloSpriteCache = new Map<number, HTMLCanvasElement | null>();

function createSpriteCanvas(size: number): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  return canvas.getContext("2d");
}

/** 光暈 sprite:每種狀態光暈色 × 解析度桶一張,全部節點共用 */
function getGlowSprite(glow: string, bucket: number): HTMLCanvasElement | null {
  const key = `${glow}|${bucket}`;
  const cached = glowSpriteCache.get(key);
  if (cached !== undefined) return cached;

  const size = SPRITE_HALF * 2 * SPRITE_SCALE * bucket;
  const spriteCtx = createSpriteCanvas(size);
  if (!spriteCtx) {
    glowSpriteCache.set(key, null);
    return null;
  }
  spriteCtx.scale(SPRITE_SCALE * bucket, SPRITE_SCALE * bucket);
  spriteCtx.translate(SPRITE_HALF, SPRITE_HALF);
  spriteCtx.shadowColor = glow;
  // shadowBlur 不受 ctx 縮放影響,依桶換算維持等效光暈大小
  spriteCtx.shadowBlur = 12 * bucket;
  hexPath(spriteCtx, 0, 0, HEX_RADIUS);
  spriteCtx.fillStyle = BG_CENTER;
  spriteCtx.fill();
  glowSpriteCache.set(key, spriteCtx.canvas);
  return spriteCtx.canvas;
}

/**
 * 節點 sprite:六角底 + 頭像(或首字)。與狀態色/光暈無關,
 * 邊框改由主迴圈每幀畫(狀態色變不需重生 sprite)。
 */
function getNodeSprite(
  node: LayoutNode,
  img: HTMLImageElement | undefined,
  bucket: number,
): HTMLCanvasElement | null {
  const variant = img ? "img" : "txt";
  const key = `${node.node.channel_id}|${variant}|${bucket}`;
  const cached = nodeSpriteCache.get(key);
  if (cached) return cached;

  if (nodeSpriteBudget <= 0) {
    spriteBudgetExhausted = true;
    // 其他解析度桶的現成 sprite 先頂著,下一幀再補正確的桶
    for (const b of SPRITE_BUCKETS) {
      if (b === bucket) continue;
      const alt = nodeSpriteCache.get(`${node.node.channel_id}|${variant}|${b}`);
      if (alt) return alt;
    }
    return null;
  }

  const size = SPRITE_HALF * 2 * SPRITE_SCALE * bucket;
  const spriteCtx = createSpriteCanvas(size);
  if (!spriteCtx) return null;
  nodeSpriteBudget -= 1;

  spriteCtx.scale(SPRITE_SCALE * bucket, SPRITE_SCALE * bucket);
  spriteCtx.translate(SPRITE_HALF, SPRITE_HALF);
  const r = HEX_RADIUS;

  if (img) {
    hexPath(spriteCtx, 0, 0, r - 2);
    spriteCtx.fillStyle = BG_CENTER;
    spriteCtx.fill();
    spriteCtx.save();
    hexPath(spriteCtx, 0, 0, r - 2);
    spriteCtx.clip();
    spriteCtx.drawImage(img, -r, -r, r * 2, r * 2);
    spriteCtx.restore();
  } else {
    hexPath(spriteCtx, 0, 0, r - 2);
    spriteCtx.fillStyle = BG_CENTER;
    spriteCtx.fill();
    hexPath(spriteCtx, 0, 0, r - 2);
    spriteCtx.fillStyle = "rgba(255,255,255,0.06)";
    spriteCtx.fill();
    spriteCtx.fillStyle = LABEL_COLOR;
    spriteCtx.font = `${r * 0.9}px sans-serif`;
    spriteCtx.textAlign = "center";
    spriteCtx.textBaseline = "middle";
    spriteCtx.fillText(channelInitial(node.node), 0, 1);
  }

  if (nodeSpriteCache.size >= MAX_SPRITE_CACHE) nodeSpriteCache.clear();
  const canvas = spriteCtx.canvas;
  nodeSpriteCache.set(key, canvas);
  return canvas;
}

/** 標籤 sprite:每個節點的多行標籤渲染一次(最壞情況字級 × 2 倍解析度),之後縮放 blit */
const labelSpriteCache = new Map<string, HTMLCanvasElement | null>();
const LABEL_SPRITE_SCALE = 2;
const LABEL_SPRITE_PAD = 4;

function getLabelSprite(node: LayoutNode, bucket: number): HTMLCanvasElement | null {
  const key = `${node.node.channel_id}|${bucket}`;
  const cached = labelSpriteCache.get(key);
  if (cached !== undefined) return cached;

  if (labelSpriteBudget <= 0) {
    spriteBudgetExhausted = true;
    for (const b of SPRITE_BUCKETS) {
      if (b === bucket) continue;
      const alt = labelSpriteCache.get(`${node.node.channel_id}|${b}`);
      if (alt) return alt;
    }
    return null;
  }
  labelSpriteBudget -= 1;

  const renderScale = LABEL_SPRITE_SCALE * bucket;
  const worstFont = FONT_BASE / FONT_MIN_SCALE;
  const lineHeight = worstFont * LINE_HEIGHT_RATIO;
  const width = Math.ceil((node.labelHalfWidth * 2 + LABEL_SPRITE_PAD * 2) * renderScale);
  const height = Math.ceil(
    (node.labelLines.length * lineHeight + LABEL_SPRITE_PAD * 2) * renderScale,
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

  spriteCtx.scale(renderScale, renderScale);
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

/** 星空 sprite:每個 star field 陣列只渲染一次,之後每幀整張 blit 到平移位置 */
interface StarFieldSprite {
  canvas: HTMLCanvasElement;
  /** sprite 內對應世界座標 (0, 0) 的像素座標 */
  originX: number;
  originY: number;
}
const starFieldSpriteCache = new WeakMap<object, StarFieldSprite>();

function getStarFieldSprite(stars: RenderState["starField"]): StarFieldSprite | null {
  const cached = starFieldSpriteCache.get(stars);
  if (cached) return cached;
  if (typeof document === "undefined" || !stars.length) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of stars) {
    if (s.x - s.r < minX) minX = s.x - s.r;
    if (s.y - s.r < minY) minY = s.y - s.r;
    if (s.x + s.r > maxX) maxX = s.x + s.r;
    if (s.y + s.r > maxY) maxY = s.y + s.r;
  }
  const pad = 4;
  const width = Math.ceil(maxX - minX) + pad * 2;
  const height = Math.ceil(maxY - minY) + pad * 2;

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(width, 1);
  canvas.height = Math.max(height, 1);
  const spriteCtx = canvas.getContext("2d");
  if (!spriteCtx) return null;

  const originX = -minX + pad;
  const originY = -minY + pad;
  spriteCtx.translate(originX, originY);
  spriteCtx.fillStyle = "#ffffff";
  for (const s of stars) {
    spriteCtx.globalAlpha = s.alpha;
    spriteCtx.beginPath();
    spriteCtx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    spriteCtx.fill();
  }

  const sprite: StarFieldSprite = { canvas, originX, originY };
  starFieldSpriteCache.set(stars, sprite);
  return sprite;
}

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
  const cx = width / 2 + transform.x * 0.3;
  const cy = height / 2 + transform.y * 0.3;
  const sprite = getStarFieldSprite(stars);
  if (sprite) {
    ctx.drawImage(sprite.canvas, cx - sprite.originX, cy - sprite.originY);
  } else {
    // fallback(測試環境等):逐一畫
    ctx.save();
    ctx.translate(cx, cy);
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
  nodeSpriteBudget = NODE_SPRITE_BUDGET_PER_FRAME;
  labelSpriteBudget = LABEL_SPRITE_BUDGET_PER_FRAME;
  spriteBudgetExhausted = false;
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
  // 解析度桶依「css 縮放 × dpr」選,螢幕上的實際像素密度才是準
  const bucket = spriteBucketFor(scale * dpr);

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
  // 外框依 (color, width, alpha) 分桶,收成 Path2D 於節點迴圈後一次 stroke(千節點省下大量 GPU submit)
  const strokeGroups = canBatchEdges
    ? new Map<string, { color: string; width: number; alpha: number; path: Path2D }>()
    : null;

  layout.nodes.forEach((node, i) => {
    if (!visible[i]) return;
    const { color, glow, dim } = nodeVisual(node, state);
    const hovered = state.hoveredId === node.node.channel_id;
    const nodeAlpha = dim && !hovered ? NODE_DIM_ALPHA : 1;
    ctx.globalAlpha = nodeAlpha;

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

    // 光暈(依狀態光暈色共用 sprite,不依節點)
    const glowSprite = getGlowSprite(glow, bucket);
    if (glowSprite) {
      ctx.drawImage(
        glowSprite,
        node.x - SPRITE_HALF,
        node.y - SPRITE_HALF,
        SPRITE_HALF * 2,
        SPRITE_HALF * 2,
      );
    }

    const sprite = getNodeSprite(node, img, bucket);
    if (sprite) {
      ctx.drawImage(
        sprite,
        node.x - SPRITE_HALF,
        node.y - SPRITE_HALF,
        SPRITE_HALF * 2,
        SPRITE_HALF * 2,
      );
    } else {
      // sprite 尚未生成(限額中)或測試環境:直接繪製簡化版
      const r = HEX_RADIUS;
      hexPath(ctx, node.x, node.y, r - 2);
      ctx.fillStyle = BG_CENTER;
      ctx.fill();
      ctx.fillStyle = LABEL_COLOR;
      ctx.font = `${r * 0.9}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(channelInitial(node.node), node.x, node.y + 1);
    }

    // 狀態色邊框:批次收集或逐一 stroke(fallback)
    const strokeWidth = hovered ? 3 : 2;
    if (strokeGroups) {
      const key = `${color}|${strokeWidth}|${nodeAlpha}`;
      let group = strokeGroups.get(key);
      if (!group) {
        group = { color, width: strokeWidth, alpha: nodeAlpha, path: new Path2D() };
        strokeGroups.set(key, group);
      }
      addHexToPath(group.path, node.x, node.y, HEX_RADIUS);
    } else {
      hexPath(ctx, node.x, node.y, HEX_RADIUS);
      ctx.strokeStyle = color;
      ctx.lineWidth = strokeWidth;
      ctx.stroke();
    }
  });

  if (strokeGroups) {
    for (const group of strokeGroups.values()) {
      ctx.globalAlpha = group.alpha;
      ctx.strokeStyle = group.color;
      ctx.lineWidth = group.width;
      ctx.stroke(group.path);
    }
  }
  ctx.globalAlpha = 1;

  // ── 標籤(固定在節點下方置中;layout 已保證互不重疊)──
  if (!dotsOnly) {
    drawLabels(ctx, scale, state, visible, bucket);
  }
  ctx.restore();

  // sprite 沒生完:下一幀接著補
  if (spriteBudgetExhausted) {
    state.requestRepaint?.();
  }

  if (import.meta.env.DEV) {
    recordFrameTime(performance.now() - frameStart);
  }
}

function drawLabels(
  ctx: CanvasRenderingContext2D,
  scale: number,
  state: RenderState,
  visible: Uint8Array,
  bucket: number,
) {
  // scale >= FONT_MIN_SCALE 時螢幕字級恆定,更小時字跟著世界縮小(空間已按最壞情況保留)
  const fontSize = FONT_BASE / Math.max(scale, FONT_MIN_SCALE);
  const lineHeight = fontSize * LINE_HEIGHT_RATIO;
  const worstFont = FONT_BASE / FONT_MIN_SCALE;
  const worstLineHeight = worstFont * LINE_HEIGHT_RATIO;
  // sprite 以最壞情況字級渲染,依目前字級等比縮小
  const ratio = fontSize / worstFont;
  let fontSet = false;

  state.layout.nodes.forEach((node, i) => {
    if (!visible[i]) return;
    const hovered = state.hoveredId === node.node.channel_id;
    const { dim } = nodeVisual(node, state);
    const startY = node.y + HEX_RADIUS + fontSize * LABEL_GAP_RATIO;

    const sprite = getLabelSprite(node, bucket);
    if (sprite) {
      ctx.globalAlpha = dim && !hovered ? 0.4 : 1;
      // 目的尺寸由節點度量推導(sprite 可能是其他解析度桶的替代品,不能除 sprite 尺寸)
      const destW = (node.labelHalfWidth * 2 + LABEL_SPRITE_PAD * 2) * ratio;
      const destH =
        (node.labelLines.length * worstLineHeight + LABEL_SPRITE_PAD * 2) * ratio;
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

/** 命中測試:走 hitGrid 只掃 3×3 桶,取繪製順序最上層的命中節點 */
export function hitTest(layout: GraphLayout, worldX: number, worldY: number): LayoutNode | null {
  const { hitGrid, nodes } = layout;
  const { cellSize, cells } = hitGrid;
  const cx = Math.floor(worldX / cellSize);
  const cy = Math.floor(worldY / cellSize);
  const r2 = (HEX_RADIUS + 4) ** 2;

  let bestIndex = -1;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const bucket = cells.get(packHitCell(cx + dx, cy + dy));
      if (!bucket) continue;
      for (const i of bucket) {
        if (i <= bestIndex) continue;
        const n = nodes[i];
        const ddx = n.x - worldX;
        const ddy = n.y - worldY;
        if (ddx * ddx + ddy * ddy <= r2) bestIndex = i;
      }
    }
  }
  return bestIndex >= 0 ? nodes[bestIndex] : null;
}
