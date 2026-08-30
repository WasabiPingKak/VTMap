/**
 * 矩形分離後處理:force layout 跑完後,把「節點 + 下方標籤」的佔用矩形
 * 兩兩推開到零重疊。邊長因此不均勻,這是預期行為。
 *
 * 效能:每輪迭代用均勻網格(spatial hash)只比對鄰近節點,
 * 千節點規模下取代 O(n²) 全配對。
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

function separatePair(a: FootprintNode, b: FootprintNode, padding: number): boolean {
  const overlapX =
    Math.min(a.x + a.halfWidth, b.x + b.halfWidth) -
    Math.max(a.x - a.halfWidth, b.x - b.halfWidth) +
    padding;
  const overlapY =
    Math.min(a.y + a.bottomHeight, b.y + b.bottomHeight) -
    Math.max(a.y - a.topHeight, b.y - b.topHeight) +
    padding;
  if (overlapX <= 0 || overlapY <= 0) return false;

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
  return true;
}

/** 就地調整座標,回傳實際迭代次數 */
export function resolveRectCollisions(nodes: FootprintNode[], padding = PADDING): number {
  if (nodes.length < 2) return 0;

  // 網格尺寸:取最大佔用矩形邊長,保證重疊對一定落在相鄰網格內
  let cellSize = 1;
  for (const n of nodes) {
    cellSize = Math.max(cellSize, n.halfWidth * 2 + padding, n.topHeight + n.bottomHeight + padding);
  }

  let iteration = 0;
  for (; iteration < MAX_ITERATIONS; iteration++) {
    let moved = false;

    // 依目前座標建網格
    const grid = new Map<string, number[]>();
    for (let i = 0; i < nodes.length; i++) {
      const key = `${Math.floor(nodes[i].x / cellSize)},${Math.floor(nodes[i].y / cellSize)}`;
      const bucket = grid.get(key);
      if (bucket) bucket.push(i);
      else grid.set(key, [i]);
    }

    for (const [key, bucket] of grid) {
      const [cx, cy] = key.split(",").map(Number);
      // 同格內全配對
      for (let s = 0; s < bucket.length; s++) {
        for (let t = s + 1; t < bucket.length; t++) {
          if (separatePair(nodes[bucket[s]], nodes[bucket[t]], padding)) moved = true;
        }
      }
      // 與右、下、右下、左下四個鄰格比對(避免重複配對)
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
        [1, 1],
        [-1, 1],
      ]) {
        const neighborBucket = grid.get(`${cx + dx},${cy + dy}`);
        if (!neighborBucket) continue;
        for (const s of bucket) {
          for (const t of neighborBucket) {
            if (separatePair(nodes[s], nodes[t], padding)) moved = true;
          }
        }
      }
    }

    if (!moved) break;
  }
  return iteration;
}
