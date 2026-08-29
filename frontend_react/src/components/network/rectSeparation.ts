/**
 * 矩形分離後處理:force layout 跑完後,把「節點 + 下方標籤」的佔用矩形
 * 兩兩推開到零重疊。邊長因此不均勻,這是預期行為。
 */

export interface FootprintNode {
  x: number;
  y: number;
  halfWidth: number;
  topHeight: number;
  bottomHeight: number;
}

const PADDING = 8;
const MAX_ITERATIONS = 120;

/** 就地調整座標,回傳實際迭代次數(等於 MAX_ITERATIONS 表示提前收斂失敗,理論上不會發生) */
export function resolveRectCollisions(nodes: FootprintNode[], padding = PADDING): number {
  let iteration = 0;
  for (; iteration < MAX_ITERATIONS; iteration++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];

        const overlapX =
          Math.min(a.x + a.halfWidth, b.x + b.halfWidth) -
          Math.max(a.x - a.halfWidth, b.x - b.halfWidth) +
          padding;
        const overlapY =
          Math.min(a.y + a.bottomHeight, b.y + b.bottomHeight) -
          Math.max(a.y - a.topHeight, b.y - b.topHeight) +
          padding;
        if (overlapX <= 0 || overlapY <= 0) continue;

        moved = true;
        // 沿重疊量較小的軸推開,各退一半
        if (overlapX < overlapY) {
          const direction = a.x <= b.x ? -1 : 1;
          const shift = (overlapX / 2) * direction;
          a.x += shift;
          b.x -= shift;
        } else {
          const direction = a.y <= b.y ? -1 : 1;
          const shift = (overlapY / 2) * direction;
          a.y += shift;
          b.y -= shift;
        }
      }
    }
    if (!moved) break;
  }
  return iteration;
}
