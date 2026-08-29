/**
 * 標籤度量與換行(做法參考 VTaxon):
 * - 名字不截斷,超過最大寬度自動換行(中日韓文字逐字、拉丁文字逐詞)
 * - 以「最壞情況字級」(basePx / FONT_MIN_SCALE)計算佔用空間,
 *   layout 依此保留位置,任何縮放等級都不會重疊
 */

export const HEX_RADIUS = 22;
/** 標籤最大寬度(world px,最壞情況字級下) */
export const MAX_LABEL_WIDTH = 120;
/** 基準字級(scale >= FONT_MIN_SCALE 時螢幕上恆定此大小) */
export const FONT_BASE = 12;
/** 字級停止放大的縮放下限 */
export const FONT_MIN_SCALE = 0.55;
export const LINE_HEIGHT_RATIO = 1.25;
/** 標籤與節點的垂直間隔比例(相對字級) */
export const LABEL_GAP_RATIO = 0.3;

export type MeasureFn = (text: string) => number;

/** 最壞情況的世界座標字級 */
export const WORST_FONT = FONT_BASE / FONT_MIN_SCALE;

// CJK 統一表意文字、假名、諺文、相容表意文字、全形符號
const CJK_RE = /[⺀-鿿가-힯豈-﫿＀-￯]/;

/** 把文字切成不可分割的 token:CJK 逐字、拉丁字母/數字成詞、空白為界 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  for (const ch of text) {
    if (/\s/.test(ch)) {
      if (current) tokens.push(current);
      current = "";
      tokens.push(" ");
    } else if (CJK_RE.test(ch)) {
      if (current) tokens.push(current);
      current = "";
      tokens.push(ch);
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

export interface WrappedLabel {
  lines: string[];
  /** 最寬一行的寬度(最壞情況字級) */
  widest: number;
}

/** 依最大寬度換行。measure 需以最壞情況字級測量。 */
export function wrapLabel(
  text: string,
  measure: MeasureFn,
  maxWidth = MAX_LABEL_WIDTH,
): WrappedLabel {
  const full = text || "";
  const fullWidth = measure(full);
  if (fullWidth <= maxWidth) return { lines: [full], widest: fullWidth };

  const lines: string[] = [];
  let current = "";
  for (const token of tokenize(full)) {
    if (token === " " && !current) continue;
    const candidate = current + token;
    if (current && measure(candidate) > maxWidth) {
      lines.push(current.trimEnd());
      current = token === " " ? "" : token;
    } else {
      current = candidate;
    }
  }
  if (current.trimEnd()) lines.push(current.trimEnd());
  if (!lines.length) lines.push(full);

  const widest = Math.min(Math.max(...lines.map((l) => measure(l))), maxWidth);
  return { lines, widest };
}

export interface LabelMetrics {
  lines: string[];
  /** 佔用矩形的半寬(含節點本體) */
  halfWidth: number;
  /** 節點中心以下的佔用高度(節點 + 間隔 + 全部文字行) */
  bottomHeight: number;
  /** 節點中心以上的佔用高度 */
  topHeight: number;
}

/** 計算節點(六角形 + 下方標籤)的最壞情況佔用空間 */
export function computeLabelMetrics(text: string, measure: MeasureFn): LabelMetrics {
  const { lines, widest } = wrapLabel(text, measure);
  const lineHeight = WORST_FONT * LINE_HEIGHT_RATIO;
  return {
    lines,
    halfWidth: Math.max(widest / 2, HEX_RADIUS),
    bottomHeight: HEX_RADIUS + WORST_FONT * LABEL_GAP_RATIO + lines.length * lineHeight,
    topHeight: HEX_RADIUS,
  };
}

/** 預設測量:offscreen canvas;無法取得(如測試環境)時用估算 */
export function createDefaultMeasure(): MeasureFn {
  const approx: MeasureFn = (text) => {
    let width = 0;
    for (const ch of text) {
      width += CJK_RE.test(ch) ? WORST_FONT : WORST_FONT * 0.55;
    }
    return width;
  };
  if (typeof document === "undefined") return approx;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return approx;
  ctx.font = `${WORST_FONT}px sans-serif`;
  return (text) => ctx.measureText(text).width;
}
