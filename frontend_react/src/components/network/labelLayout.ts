/**
 * 標籤防碰撞放置:候選位置依序為下、上、右、左,
 * 與已放置的標籤或任何節點相撞就換下一個,全部撞到則不顯示。
 * 純函式,座標一律使用世界座標。
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LabelItem {
  id: string;
  /** 節點中心 */
  anchorX: number;
  anchorY: number;
  /** 節點半徑(標籤與節點的間隔基準) */
  nodeRadius: number;
  width: number;
  height: number;
  /** 越大越優先佔位 */
  priority: number;
  /** true 時即使全部候選位置都相撞,仍以預設位置顯示(聚焦/hover) */
  alwaysShow?: boolean;
}

const GAP = 5;
const PADDING = 2;

function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x - PADDING < b.x + b.w &&
    a.x + a.w + PADDING > b.x &&
    a.y - PADDING < b.y + b.h &&
    a.y + a.h + PADDING > b.y
  );
}

function candidates(item: LabelItem): Rect[] {
  const { anchorX, anchorY, nodeRadius: r, width: w, height: h } = item;
  return [
    { x: anchorX - w / 2, y: anchorY + r + GAP, w, h }, // 下
    { x: anchorX - w / 2, y: anchorY - r - GAP - h, w, h }, // 上
    { x: anchorX + r + GAP, y: anchorY - h / 2, w, h }, // 右
    { x: anchorX - r - GAP - w, y: anchorY - h / 2, w, h }, // 左
  ];
}

/**
 * 回傳 id → 放置矩形。沒被放置的標籤不在結果中。
 * @param obstacles 不可壓到的固定障礙(所有節點的外接方框)
 */
export function placeLabels(items: LabelItem[], obstacles: Rect[]): Map<string, Rect> {
  const sorted = [...items].sort((a, b) => b.priority - a.priority);
  const placed = new Map<string, Rect>();
  const placedRects: Rect[] = [];

  for (const item of sorted) {
    const options = candidates(item);
    let chosen: Rect | null = null;
    for (const rect of options) {
      const hitObstacle = obstacles.some((o) => intersects(rect, o));
      const hitLabel = placedRects.some((p) => intersects(rect, p));
      if (!hitObstacle && !hitLabel) {
        chosen = rect;
        break;
      }
    }
    if (!chosen && item.alwaysShow) {
      chosen = options[0];
    }
    if (chosen) {
      placed.set(item.id, chosen);
      placedRects.push(chosen);
    }
  }
  return placed;
}
