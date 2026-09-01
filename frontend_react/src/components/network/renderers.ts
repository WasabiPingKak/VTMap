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
import type { GraphLayout, LayoutEdge, LayoutNode } from "@/types/network";
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
  EDGE_HOP_ALPHA,
  FAR_COLOR,
  FAR_GLOW,
  FOCUSED_COLOR,
  FOCUSED_GLOW,
  HOP1_EDGE_COLOR,
  HOP2_COLOR,
  HOP2_EDGE_COLOR,
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
/** 縮放小於此值時 glow 光暈幾乎不可見,跳過 drawImage 省一半節點繪製呼叫 */
const GLOW_MIN_SCALE = 0.4;
/** 縮放小於此值時社群 halo 相互重疊糊在一起,不畫可省下大量 overdraw */
const HALO_MIN_SCALE = 0.35;
/** 社群暈染半徑(world px) */
const HALO_RADIUS = 110;
/** 視野裁剪的寬容邊距(world px,涵蓋暈染與標籤外溢) */
const CULL_MARGIN = 160;

/** dim 節點層的預烘 offscreen canvas(ego 模式用):
 *  - canvas 涵蓋所有 dim 節點的 AABB,以 pxPerWorld 解析度
 *  - 每幀單一 drawImage 取代 per-dim-node 的 sprite drawImage(數百次省成一次) */
export interface BakedDimLayer {
  canvas: HTMLCanvasElement;
  /** canvas 左上對應的世界座標(minX, minY) */
  worldX: number;
  worldY: number;
  /** 世界寬高(=canvas.width / pxPerWorld) */
  worldW: number;
  worldH: number;
}

/** 單一邊層的預烘 offscreen canvas:
 *  - canvas 涵蓋該層所有邊的 AABB
 *  - 每幀 drawImage 一次取代 per-widthBucket 的 Path2D stroke,
 *    GPU 端把「上千條 bezier 光柵化」壓縮成「一次紋理採樣」 */
export interface BakedEdgeCanvas {
  canvas: HTMLCanvasElement;
  worldX: number;
  worldY: number;
  worldW: number;
  worldH: number;
}

/** 四種邊層(對應 bakedEdges.base/baseHop1/baseHop2/dim)各自的 bake。
 *  null 表示該層無邊或超尺寸,渲染時 fallback 到 per-widthBucket stroke。 */
export interface BakedEdgeLayers {
  base: BakedEdgeCanvas | null;
  baseHop1: BakedEdgeCanvas | null;
  baseHop2: BakedEdgeCanvas | null;
  dim: BakedEdgeCanvas | null;
}

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
  /** dim 節點層預烘結果;有值時節點迴圈跳過 dim 節點的 sprite drawImage,改成整層 blit */
  bakedDimLayer?: BakedDimLayer | null;
  /** 4 層邊(base/baseHop1/baseHop2/dim)的預烘結果;各層有 canvas 就走 drawImage,
   *  沒有(fallback:超尺寸/建立失敗)就走原本 per-widthBucket stroke */
  bakedEdgeLayers?: BakedEdgeLayers | null;
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

/** 把一個節點的「六角底 + 頭像或首字」畫到目標 ctx 的目前原點,不含 outline/glow */
function drawNodeShape(
  ctx: CanvasRenderingContext2D,
  node: LayoutNode,
  img: HTMLImageElement | undefined,
) {
  const r = HEX_RADIUS;
  hexPath(ctx, 0, 0, r - 2);
  ctx.fillStyle = BG_CENTER;
  ctx.fill();
  if (img) {
    ctx.save();
    hexPath(ctx, 0, 0, r - 2);
    ctx.clip();
    ctx.drawImage(img, -r, -r, r * 2, r * 2);
    ctx.restore();
  } else {
    hexPath(ctx, 0, 0, r - 2);
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fill();
    ctx.fillStyle = LABEL_COLOR;
    ctx.font = `${r * 0.9}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(channelInitial(node.node), 0, 1);
  }
}

/** 每邊最大 offscreen canvas 尺寸(GPU / 記憶體上限考量;超過 fallback 走 per-frame) */
const EDGE_BAKE_MAX_PX = 4096;
/** 邊層 bake 的解析度(每世界單位對應多少 canvas 像素) */
const EDGE_BAKE_PX_PER_WORLD = 1;
/** bake 時的 AABB pad,涵蓋 bezier 控制點外凸與線寬本身 */
const EDGE_BAKE_PAD = 40;
/** dim 節點層 bake 的解析度與尺寸上限沿用邊層設定 */
const DIM_LAYER_MAX_PX = EDGE_BAKE_MAX_PX;
const DIM_LAYER_PX_PER_WORLD = EDGE_BAKE_PX_PER_WORLD;

/**
 * 把 ego 模式下所有 dim(EGO_OUTER_RING)節點的 sprite 烘進單一 offscreen canvas。
 * 每幀渲染時 drawImage 一次覆蓋所有 dim 節點,取代 per-node sprite drawImage(數百次省成一次)。
 * 頭像有 cached 就用,否則畫 initial。超過尺寸上限則回傳 null,走 per-frame fallback。
 */
export function bakeDimLayer(
  layout: GraphLayout,
  images: Map<string, HTMLImageElement>,
): BakedDimLayer | null {
  if (typeof document === "undefined") return null;
  const rings = layout.rings;
  if (!rings) return null;

  // 收集 dim 節點與其 AABB
  const dimNodes: LayoutNode[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of layout.nodes) {
    if (rings.get(n.node.channel_id) !== EGO_OUTER_RING) continue;
    dimNodes.push(n);
    if (n.x - HEX_RADIUS < minX) minX = n.x - HEX_RADIUS;
    if (n.y - HEX_RADIUS < minY) minY = n.y - HEX_RADIUS;
    if (n.x + HEX_RADIUS > maxX) maxX = n.x + HEX_RADIUS;
    if (n.y + HEX_RADIUS > maxY) maxY = n.y + HEX_RADIUS;
  }
  if (!dimNodes.length) return null;

  const pad = 2;
  const worldW = maxX - minX + pad * 2;
  const worldH = maxY - minY + pad * 2;
  const canvasW = Math.ceil(worldW * DIM_LAYER_PX_PER_WORLD);
  const canvasH = Math.ceil(worldH * DIM_LAYER_PX_PER_WORLD);
  if (canvasW > DIM_LAYER_MAX_PX || canvasH > DIM_LAYER_MAX_PX) return null;

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(canvasW, 1);
  canvas.height = Math.max(canvasH, 1);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.scale(DIM_LAYER_PX_PER_WORLD, DIM_LAYER_PX_PER_WORLD);
  const originX = -minX + pad;
  const originY = -minY + pad;
  for (const n of dimNodes) {
    ctx.save();
    ctx.translate(originX + n.x, originY + n.y);
    const img = n.node.thumbnail ? images.get(n.node.thumbnail) : undefined;
    drawNodeShape(ctx, n, img);
    ctx.restore();
  }

  return { canvas, worldX: minX - pad, worldY: minY - pad, worldW, worldH };
}

/**
 * dim 邊層的固定線寬(世界單位;canvas 是 1px/world,所以也就是 canvas 像素):
 * 只用來畫 ego 外圍相關的邊(alpha 0.05)。刻意不做 per-scale 反縮放,
 * 讓縮放小時線變細(視覺雜訊少)、縮放大時稍粗(dim 但可辨識),對 dim 邊而言合理。
 */
const DIM_EDGE_BAKE_LINE_WIDTH = 1.5;

interface EdgeAABB {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  has: boolean;
}

function emptyAABB(): EdgeAABB {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, has: false };
}

function extendAABB(a: EdgeAABB, le: LayoutEdge) {
  a.has = true;
  if (le.boxMinX < a.minX) a.minX = le.boxMinX;
  if (le.boxMinY < a.minY) a.minY = le.boxMinY;
  if (le.boxMaxX > a.maxX) a.maxX = le.boxMaxX;
  if (le.boxMaxY > a.maxY) a.maxY = le.boxMaxY;
}

/**
 * 對一組(widthBucket → Path2D)烘一張 offscreen canvas 並回傳。
 * 邊寬 = widthBucket(世界單位;canvas 1 px/world → 也就是 canvas 像素),
 * blit 時線寬會隨縮放線性變化(zoom in 較粗、zoom out 較細),換取 per-frame O(1) stroke。
 * 若 lineWidthOverride 給值,則所有 bucket 都用該固定寬度(dim 層用來壓細)。
 * alpha 一律 bake 1.0,實際淡化由 blit 時 globalAlpha 一次套用。
 */
function bakeEdgeGroup(
  paths: Map<number, Path2D>,
  aabb: EdgeAABB,
  strokeColor: string,
  lineWidthOverride: number | null,
): BakedEdgeCanvas | null {
  if (typeof document === "undefined") return null;
  if (!aabb.has || paths.size === 0) return null;

  const worldW = aabb.maxX - aabb.minX + EDGE_BAKE_PAD * 2;
  const worldH = aabb.maxY - aabb.minY + EDGE_BAKE_PAD * 2;
  const canvasW = Math.ceil(worldW * EDGE_BAKE_PX_PER_WORLD);
  const canvasH = Math.ceil(worldH * EDGE_BAKE_PX_PER_WORLD);
  if (canvasW > EDGE_BAKE_MAX_PX || canvasH > EDGE_BAKE_MAX_PX) return null;

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(canvasW, 1);
  canvas.height = Math.max(canvasH, 1);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.scale(EDGE_BAKE_PX_PER_WORLD, EDGE_BAKE_PX_PER_WORLD);
  ctx.translate(-aabb.minX + EDGE_BAKE_PAD, -aabb.minY + EDGE_BAKE_PAD);
  ctx.strokeStyle = strokeColor;
  ctx.lineCap = "round";
  for (const [widthBucket, path] of paths) {
    ctx.lineWidth = lineWidthOverride ?? widthBucket;
    ctx.stroke(path);
  }

  return {
    canvas,
    worldX: aabb.minX - EDGE_BAKE_PAD,
    worldY: aabb.minY - EDGE_BAKE_PAD,
    worldW,
    worldH,
  };
}

/**
 * 把 4 個邊層(base / baseHop1 / baseHop2 / dim)各烘一張 offscreen canvas。
 * 每幀渲染時對每一層 drawImage 一次(共 1~4 次)取代原本 per-widthBucket 的 stroke,
 * GPU 端把上千條 bezier 光柵化壓縮成幾次紋理採樣,dense 區拖曳/縮放大幅加速。
 *
 * 各層獨立算 AABB 與 canvas,單層超尺寸(> EDGE_BAKE_MAX_PX)則該層回傳 null,
 * 渲染 fallback 走原本的 per-widthBucket stroke,不影響其他層。
 *
 * 線寬處理:
 * - base / hop1 / hop2:用該 widthBucket 值當 canvas 線寬(世界固定寬 → 縮放時等比變化)
 * - dim:固定 DIM_EDGE_BAKE_LINE_WIDTH,視覺一致 + 更薄
 */
export function bakeEdgeLayers(layout: GraphLayout): BakedEdgeLayers | null {
  if (typeof document === "undefined") return null;
  const be = layout.bakedEdges;
  if (!be) return null;
  const rings = layout.rings;

  const aabbBase = emptyAABB();
  const aabbHop1 = emptyAABB();
  const aabbHop2 = emptyAABB();
  const aabbDim = emptyAABB();

  for (const le of layout.edges) {
    if (rings) {
      if (le.egoDim > 0) {
        extendAABB(aabbDim, le);
      } else {
        const ra = rings.get(le.edge.a) ?? 0;
        const rb = rings.get(le.edge.b) ?? 0;
        if (Math.max(ra, rb) >= 2) extendAABB(aabbHop2, le);
        else extendAABB(aabbHop1, le);
      }
    } else {
      extendAABB(aabbBase, le);
    }
  }

  return {
    base: bakeEdgeGroup(be.base, aabbBase, EDGE_COLOR, null),
    baseHop1: be.baseHop1 ? bakeEdgeGroup(be.baseHop1, aabbHop1, HOP1_EDGE_COLOR, null) : null,
    baseHop2: be.baseHop2 ? bakeEdgeGroup(be.baseHop2, aabbHop2, HOP2_EDGE_COLOR, null) : null,
    dim: be.dim ? bakeEdgeGroup(be.dim, aabbDim, EDGE_COLOR, DIM_EDGE_BAKE_LINE_WIDTH) : null,
  };
}

/** 標籤 sprite:每個節點的多行標籤渲染一次(最壞情況字級 × 2 倍解析度),之後縮放 blit */
const labelSpriteCache = new Map<string, HTMLCanvasElement | null>();
const LABEL_SPRITE_SCALE = 2;
const LABEL_SPRITE_PAD = 4;

/**
 * layout 邊界主動修剪:layout 換掉時把不再屬於當前節點集的 sprite key 全部刪掉。
 * node/label sprite key 的第一段都是 channel_id(pipe 分隔),
 * 只掃 key 字串起始到第一個 '|',不切字串陣列以節省 gc。
 * 沒這個 hook,cache 只等湊滿 MAX_SPRITE_CACHE=6000 才整批 clear,
 * HMR / 頻繁切 ego 圓心會累積用不到的舊 sprite。
 */
export function pruneNodeSpriteCaches(activeChannelIds: Set<string>) {
  const isActive = (key: string) => {
    const pipe = key.indexOf("|");
    return activeChannelIds.has(pipe === -1 ? key : key.slice(0, pipe));
  };
  for (const key of nodeSpriteCache.keys()) {
    if (!isActive(key)) nodeSpriteCache.delete(key);
  }
  for (const key of labelSpriteCache.keys()) {
    if (!isActive(key)) labelSpriteCache.delete(key);
  }
}

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
    // 星空 sprite 完全在畫面外時跳 drawImage(遠距 pan 時省下 huge blit)
    const dx = cx - sprite.originX;
    const dy = cy - sprite.originY;
    const outOfView =
      dx + sprite.canvas.width < 0 ||
      dx > width ||
      dy + sprite.canvas.height < 0 ||
      dy > height;
    if (!outOfView) ctx.drawImage(sprite.canvas, dx, dy);
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

/** 每幀節點視覺狀態預算表:visible + color/glow/dim 一次算完,節點迴圈與標籤迴圈共用 */
interface FrameVisuals {
  visible: Uint8Array;
  colors: string[];
  glows: string[];
  /** 1 = 需要淡化(已扣掉 hovered/focused 例外),0 = 全亮 */
  isDim: Uint8Array;
  hoveredNode: LayoutNode | null;
}

function computeFrameVisuals(
  state: RenderState,
  viewMinX: number,
  viewMaxX: number,
  viewMinY: number,
  viewMaxY: number,
): FrameVisuals {
  const nodes = state.layout.nodes;
  const rings = state.layout.rings;
  const hopDistances = state.hopDistances;
  const hoveredNode = state.hoveredId ? (state.layout.byId.get(state.hoveredId) ?? null) : null;

  const visible = new Uint8Array(nodes.length);
  const colors = new Array<string>(nodes.length);
  const glows = new Array<string>(nodes.length);
  const isDim = new Uint8Array(nodes.length);

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const inView =
      node.x > viewMinX && node.x < viewMaxX && node.y > viewMinY && node.y < viewMaxY;
    if (!inView) continue;
    visible[i] = 1;

    const id = node.node.channel_id;
    const distance = hopDistances?.get(id);
    let color: string;
    let glow: string;
    let dim = rings?.get(id) === EGO_OUTER_RING;
    if (distance === 0) {
      color = FOCUSED_COLOR;
      glow = FOCUSED_GLOW;
      dim = false;
    } else if (distance === 1) {
      color = NEIGHBOR_COLOR;
      glow = NEIGHBOR_GLOW;
    } else if (distance === 2) {
      color = HOP2_COLOR;
      glow = HOP2_GLOW;
    } else {
      color = FAR_COLOR;
      glow = FAR_GLOW;
    }
    colors[i] = color;
    glows[i] = glow;
    isDim[i] = dim && node !== hoveredNode ? 1 : 0;
  }

  return { visible, colors, glows, isDim, hoveredNode };
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

  // 一次算完 visible + 節點視覺狀態(color/glow/isDim/hoveredNode),兩個繪製迴圈共用
  const visuals = computeFrameVisuals(state, viewMinX, viewMaxX, viewMinY, viewMaxY);
  const { visible, colors: nColors, glows: nGlows, isDim: nIsDim, hoveredNode } = visuals;
  const nodes = layout.nodes;
  const nodeCount = nodes.length;

  // ── 社群暈染(僅全圖模式;ego 模式的環狀結構自己說話)──
  // 縮放太小時 halo 相互重疊只是一片色霧,直接跳過整段迴圈
  if (!layout.rings && layout.communities && scale >= HALO_MIN_SCALE) {
    const communities = layout.communities;
    for (let i = 0; i < nodeCount; i++) {
      if (!visible[i]) continue;
      const node = nodes[i];
      const community = communities.get(node.node.channel_id);
      if (community === undefined) continue;
      const sprite = getHaloSprite(community);
      if (!sprite) continue;
      ctx.drawImage(
        sprite,
        node.x - HALO_RADIUS,
        node.y - HALO_RADIUS,
        HALO_RADIUS * 2,
        HALO_RADIUS * 2,
      );
    }
  }

  // ── 邊 ──
  // 架構:預烘的 base/baseHop1/baseHop2/dim Path2D 每幀單一 stroke 一次畫完;
  //       hover/focus 高亮只 iterate edgesByNode 的相關小子集當 overlay 疊上去。
  //       全部邊都可見(任何縮放),per-frame 邊成本 O(1) with GPU-side rasterization。
  const canBatchEdges = typeof Path2D !== "undefined";
  const baked = layout.bakedEdges;

  if (baked) {
    // 非 ego / fallback:全部邊都在 base,灰色 EDGE_ALPHA。focus 或 hover 時淡化讓 overlay 浮出。
    const hasHighlight = state.focusedId !== null || state.hoveredId !== null;
    const baseAlpha = hasHighlight ? EDGE_DIM_ALPHA : EDGE_ALPHA;
    const hopAlpha = hasHighlight ? EDGE_DIM_ALPHA : EDGE_HOP_ALPHA;
    const bakedLayers = state.bakedEdgeLayers;
    // 每層繪製:優先走預烘 bitmap 一次 blit(GPU 端省下上千條 bezier 光柵化);
    // fallback(超尺寸/建立失敗)再走原本 per-widthBucket stroke。
    const drawGroup = (
      bake: BakedEdgeCanvas | null | undefined,
      paths: Map<number, Path2D> | null | undefined,
      color: string,
      alpha: number,
    ) => {
      if (!paths || paths.size === 0) return;
      ctx.globalAlpha = alpha;
      if (bake) {
        ctx.drawImage(bake.canvas, bake.worldX, bake.worldY, bake.worldW, bake.worldH);
        return;
      }
      ctx.strokeStyle = color;
      for (const [widthBucket, path] of paths) {
        ctx.lineWidth = widthBucket / scale;
        ctx.stroke(path);
      }
    };

    drawGroup(bakedLayers?.base, baked.base, EDGE_COLOR, baseAlpha);
    // ego 模式:hop1(中心↔hop1、hop1↔hop1)塗綠、hop2(hop1↔hop2、hop2↔hop2)塗藍,
    // 讓分層結構本身就看得見,不用等 hover 才浮現
    drawGroup(bakedLayers?.baseHop1, baked.baseHop1, HOP1_EDGE_COLOR, hopAlpha);
    drawGroup(bakedLayers?.baseHop2, baked.baseHop2, HOP2_EDGE_COLOR, hopAlpha);
    // dim:ego 外圍相關,alpha 固定 EDGE_DIM_ALPHA
    drawGroup(bakedLayers?.dim, baked.dim, EDGE_COLOR, EDGE_DIM_ALPHA);

    // hover/focus 高亮 overlay:focus 節點的邊常駐,hover 別的節點時再疊上它的邊,兩者可同時亮。
    // 上面 hop-1/2 已切過 strokeStyle,此處要重設回 EDGE_COLOR。
    const highlightIds: string[] = [];
    if (state.focusedId) highlightIds.push(state.focusedId);
    if (state.hoveredId && state.hoveredId !== state.focusedId) {
      highlightIds.push(state.hoveredId);
    }
    if (highlightIds.length) {
      const overlayGroups = new Map<number, Path2D>();
      const seenEdges = new Set<LayoutEdge>();
      for (const id of highlightIds) {
        const related = layout.edgesByNode.get(id);
        if (!related) continue;
        for (const le of related) {
          if (seenEdges.has(le)) continue;
          seenEdges.add(le);
          // hover/focus 節點的所有連線都要高亮,包含通往外圍的邊(不再依 egoDim 過濾)
          let p = overlayGroups.get(le.widthBucket);
          if (!p) {
            p = new Path2D();
            overlayGroups.set(le.widthBucket, p);
          }
          p.moveTo(le.source.x, le.source.y);
          p.quadraticCurveTo(le.controlX, le.controlY, le.target.x, le.target.y);
        }
      }
      if (overlayGroups.size) {
        ctx.strokeStyle = EDGE_COLOR;
        ctx.globalAlpha = EDGE_HIGHLIGHT_ALPHA;
        for (const [widthBucket, path] of overlayGroups) {
          ctx.lineWidth = widthBucket / scale;
          ctx.stroke(path);
        }
      }
    }
  } else {
    // fallback(測試環境無 Path2D):走原本 per-frame iterate 邏輯,不做 hop 上色
    ctx.strokeStyle = EDGE_COLOR;
    const edgeAlpha = (edgeA: string, edgeB: string): number => {
      const onFocus =
        state.focusedId !== null && (edgeA === state.focusedId || edgeB === state.focusedId);
      const onHover =
        state.hoveredId !== null && (edgeA === state.hoveredId || edgeB === state.hoveredId);
      const isHighlighted = onFocus || onHover;

      let alpha: number;
      if (isHighlighted) {
        alpha = EDGE_HIGHLIGHT_ALPHA;
      } else if (state.focusedId !== null || state.hoveredId !== null) {
        alpha = EDGE_DIM_ALPHA;
      } else {
        alpha = EDGE_ALPHA;
      }
      // 通往外圍的邊平時淡化,但如果一端正是 hover/focus 節點,保留高亮
      if (!isHighlighted && (isEgoOuter(state, edgeA) || isEgoOuter(state, edgeB))) {
        alpha = Math.min(alpha, EDGE_DIM_ALPHA);
      }
      return alpha;
    };
    void canBatchEdges;
    for (const le of layout.edges) {
      if (
        le.boxMaxX < viewMinX ||
        le.boxMinX > viewMaxX ||
        le.boxMaxY < viewMinY ||
        le.boxMinY > viewMaxY
      ) {
        continue;
      }
      ctx.globalAlpha = edgeAlpha(le.edge.a, le.edge.b);
      ctx.lineWidth = le.widthBucket / scale;
      ctx.beginPath();
      ctx.moveTo(le.source.x, le.source.y);
      ctx.quadraticCurveTo(le.controlX, le.controlY, le.target.x, le.target.y);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  // ── dim 節點層(ego 模式):預烘的整層 offscreen canvas 一次 blit 覆蓋所有 dim 節點的 sprite ──
  const bakedDim = state.bakedDimLayer;
  const useBakedDim = !!bakedDim && !dotsOnly;
  if (useBakedDim && bakedDim) {
    ctx.globalAlpha = NODE_DIM_ALPHA;
    ctx.drawImage(bakedDim.canvas, bakedDim.worldX, bakedDim.worldY, bakedDim.worldW, bakedDim.worldH);
    ctx.globalAlpha = 1;
  }

  // ── 節點 ──
  // 外框依 (color, width, alpha) 分桶,收成 Path2D 於節點迴圈後一次 stroke(千節點省下大量 GPU submit)
  const strokeGroups = canBatchEdges
    ? new Map<string, { color: string; width: number; alpha: number; path: Path2D }>()
    : null;
  const drawGlow = scale >= GLOW_MIN_SCALE;

  for (let i = 0; i < nodeCount; i++) {
    if (!visible[i]) continue;
    const node = nodes[i];
    const color = nColors[i];
    const isDim = nIsDim[i];
    const hovered = node === hoveredNode;
    const nodeAlpha = isDim ? NODE_DIM_ALPHA : 1;
    ctx.globalAlpha = nodeAlpha;

    if (dotsOnly) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(node.x, node.y, 6 / Math.max(scale, 0.08), 0, Math.PI * 2);
      ctx.fill();
      continue;
    }

    // 頭像延遲載入:實際可見才發請求
    let img: HTMLImageElement | undefined;
    if (node.node.thumbnail) {
      img = state.images.get(node.node.thumbnail);
      if (!img) state.requestImage?.(node.node.thumbnail);
    }

    // 光暈(依狀態光暈色共用 sprite,不依節點)
    // dim 節點本身已 alpha 0.25,再疊 glow 幾乎看不見;縮放太小時也完全不畫
    if (drawGlow && !isDim) {
      const glowSprite = getGlowSprite(nGlows[i], bucket);
      if (glowSprite) {
        ctx.drawImage(
          glowSprite,
          node.x - SPRITE_HALF,
          node.y - SPRITE_HALF,
          SPRITE_HALF * 2,
          SPRITE_HALF * 2,
        );
      }
    }

    // dim 節點的 sprite 已在上面預烘層一次畫完,per-node 這裡跳過(節省數百次 drawImage)
    // outline 仍走 strokeGroups(顏色可能隨 focus 變),hovered 例外要重畫(hovered 邊界較粗需要蓋在 baked 上)
    if (useBakedDim && isDim && !hovered) {
      const strokeWidth = 2;
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
      continue;
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
  }

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
    drawLabels(ctx, scale, state, visuals, bucket);
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
  visuals: FrameVisuals,
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

  const nodes = state.layout.nodes;
  const { visible, isDim } = visuals;
  const nodeCount = nodes.length;
  for (let i = 0; i < nodeCount; i++) {
    if (!visible[i]) continue;
    const dim = isDim[i];
    const node = nodes[i];
    const startY = node.y + HEX_RADIUS + fontSize * LABEL_GAP_RATIO;

    const sprite = getLabelSprite(node, bucket);
    if (sprite) {
      ctx.globalAlpha = dim ? 0.4 : 1;
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
      continue;
    }

    // fallback(測試環境等):直接 fillText
    if (!fontSet) {
      ctx.font = `${fontSize}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      fontSet = true;
    }
    ctx.fillStyle = dim ? LABEL_DIM : LABEL_COLOR;
    const lines = node.labelLines;
    for (let j = 0; j < lines.length; j++) {
      ctx.fillText(lines[j], node.x, startY + j * lineHeight);
    }
  }
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
