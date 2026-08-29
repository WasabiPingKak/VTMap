/**
 * 關係網路的 Canvas 繪製:星空背景、邊、六角形頭像節點、標籤。
 * 六角形節點語彙移植自 VTaxon。
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
  DISCOVERED_COLOR,
  DISCOVERED_GLOW,
  EDGE_ALPHA,
  EDGE_COLOR,
  EDGE_DIM_ALPHA,
  EDGE_HIGHLIGHT_ALPHA,
  FOCUSED_COLOR,
  FOCUSED_GLOW,
  IN_VTMAP_COLOR,
  IN_VTMAP_GLOW,
  LABEL_COLOR,
  LABEL_DIM,
  NEIGHBOR_COLOR,
  NEIGHBOR_GLOW,
  NODE_DIM_ALPHA,
} from "./colors";

export { HEX_RADIUS } from "./labelMetrics";
/** 縮放小於此值時節點退化為圓點、不畫標籤(LOD) */
const DOTS_ONLY_SCALE = 0.25;

export interface RenderState {
  layout: GraphLayout;
  images: Map<string, HTMLImageElement>;
  hoveredId: string | null;
  focusedId: string | null;
  /** 聚焦節點的鄰居 id(含聚焦節點本身時視為高亮) */
  highlightIds: Set<string> | null;
  starField: { x: number; y: number; r: number; alpha: number }[];
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

function drawBackground(
  ctx: CanvasRenderingContext2D,
  transform: CanvasTransform,
  width: number,
  height: number,
  stars: RenderState["starField"],
) {
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, width, height);

  const grad = ctx.createRadialGradient(
    width / 2,
    height / 2,
    0,
    width / 2,
    height / 2,
    Math.max(width, height) * 0.7,
  );
  grad.addColorStop(0, BG_CENTER);
  grad.addColorStop(1, BG_COLOR);
  ctx.fillStyle = grad;
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
  if (state.focusedId === id) return { color: FOCUSED_COLOR, glow: FOCUSED_GLOW, dim: false };
  if (state.highlightIds?.has(id))
    return { color: NEIGHBOR_COLOR, glow: NEIGHBOR_GLOW, dim: false };
  const dim = state.highlightIds !== null || isEgoOuter(state, id);
  if (node.node.in_vtmap) return { color: IN_VTMAP_COLOR, glow: IN_VTMAP_GLOW, dim };
  return { color: DISCOVERED_COLOR, glow: DISCOVERED_GLOW, dim };
}

export function drawNetwork(
  ctx: CanvasRenderingContext2D,
  transform: CanvasTransform,
  sizeWidth: number,
  sizeHeight: number,
  state: RenderState,
) {
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

  // ── 社群暈染(僅全圖模式;ego 模式的環狀結構自己說話)──
  if (!layout.rings && layout.communities) {
    for (const node of layout.nodes) {
      const community = layout.communities.get(node.node.channel_id);
      if (community === undefined) continue;
      const radius = 110;
      const gradient = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, radius);
      gradient.addColorStop(0, communityColor(community, 0.07));
      gradient.addColorStop(1, communityColor(community, 0));
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ── 邊(輕微弧線,交叉時角度自然錯開)──
  for (const { edge, source, target } of layout.edges) {
    let alpha = EDGE_ALPHA;
    if (state.highlightIds !== null) {
      const onFocus =
        state.focusedId !== null &&
        (edge.a === state.focusedId || edge.b === state.focusedId);
      alpha = onFocus ? EDGE_HIGHLIGHT_ALPHA : EDGE_DIM_ALPHA;
    } else if (state.hoveredId && (edge.a === state.hoveredId || edge.b === state.hoveredId)) {
      alpha = EDGE_HIGHLIGHT_ALPHA;
    }
    // ego 模式:任一端在外圍的邊一律淡化
    if (isEgoOuter(state, edge.a) || isEgoOuter(state, edge.b)) {
      alpha = Math.min(alpha, EDGE_DIM_ALPHA);
    }
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = EDGE_COLOR;
    ctx.lineWidth = Math.min(1 + edge.evidence_count * 0.6, 5) / scale;

    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const length = Math.hypot(dx, dy) || 1;
    const bow = Math.min(length * 0.1, 36);
    const controlX = (source.x + target.x) / 2 - (dy / length) * bow;
    const controlY = (source.y + target.y) / 2 + (dx / length) * bow;

    ctx.beginPath();
    ctx.moveTo(source.x, source.y);
    ctx.quadraticCurveTo(controlX, controlY, target.x, target.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // ── 節點 ──
  for (const node of layout.nodes) {
    const { color, glow, dim } = nodeVisual(node, state);
    const hovered = state.hoveredId === node.node.channel_id;
    ctx.globalAlpha = dim && !hovered ? NODE_DIM_ALPHA : 1;

    if (dotsOnly) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(node.x, node.y, 6 / Math.max(scale, 0.08), 0, Math.PI * 2);
      ctx.fill();
      continue;
    }

    const r = HEX_RADIUS;

    // 光暈
    ctx.save();
    ctx.shadowColor = glow;
    ctx.shadowBlur = hovered ? 22 : 12;
    hexPath(ctx, node.x, node.y, r);
    ctx.fillStyle = BG_CENTER;
    ctx.fill();
    ctx.restore();

    // 頭像(六角形裁切)
    const img = node.node.thumbnail ? state.images.get(node.node.thumbnail) : undefined;
    if (img) {
      ctx.save();
      hexPath(ctx, node.x, node.y, r - 2);
      ctx.clip();
      ctx.drawImage(img, node.x - r, node.y - r, r * 2, r * 2);
      ctx.restore();
    } else {
      // 沒頭像:畫首字
      hexPath(ctx, node.x, node.y, r - 2);
      ctx.fillStyle = "rgba(255,255,255,0.06)";
      ctx.fill();
      ctx.fillStyle = LABEL_COLOR;
      ctx.font = `${r * 0.9}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(channelInitial(node.node), node.x, node.y + 1);
    }

    // 邊框
    hexPath(ctx, node.x, node.y, r);
    ctx.strokeStyle = color;
    ctx.lineWidth = hovered ? 3 : 2;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // ── 標籤(固定在節點下方置中;layout 已保證互不重疊)──
  if (!dotsOnly) {
    drawLabels(ctx, scale, state);
  }
  ctx.restore();
}

function drawLabels(ctx: CanvasRenderingContext2D, scale: number, state: RenderState) {
  // scale >= FONT_MIN_SCALE 時螢幕字級恆定,更小時字跟著世界縮小(空間已按最壞情況保留)
  const fontSize = FONT_BASE / Math.max(scale, FONT_MIN_SCALE);
  const lineHeight = fontSize * LINE_HEIGHT_RATIO;
  ctx.font = `${fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  for (const node of state.layout.nodes) {
    const hovered = state.hoveredId === node.node.channel_id;
    const { dim } = nodeVisual(node, state);
    ctx.fillStyle = dim && !hovered ? LABEL_DIM : LABEL_COLOR;
    const startY = node.y + HEX_RADIUS + fontSize * LABEL_GAP_RATIO;
    node.labelLines.forEach((line, i) => {
      ctx.fillText(line, node.x, startY + i * lineHeight);
    });
  }
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
