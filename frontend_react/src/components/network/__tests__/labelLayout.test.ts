import { describe, it, expect } from "vitest";
import { placeLabels, type LabelItem, type Rect } from "../labelLayout";

function item(overrides: Partial<LabelItem> & { id: string }): LabelItem {
  return {
    anchorX: 0,
    anchorY: 0,
    nodeRadius: 22,
    width: 80,
    height: 12,
    priority: 0,
    ...overrides,
  };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

describe("placeLabels", () => {
  it("無碰撞時放在預設位置(節點下方)", () => {
    const placed = placeLabels([item({ id: "a" })], []);
    const rect = placed.get("a")!;
    expect(rect.y).toBeGreaterThan(22); // 在節點半徑之下
    expect(rect.x).toBeCloseTo(-40); // 水平置中
  });

  it("兩個相鄰節點的標籤不重疊", () => {
    // 兩節點垂直排列,下方標籤的預設位置會撞到彼此
    const items = [
      item({ id: "a", anchorX: 0, anchorY: 0, priority: 2 }),
      item({ id: "b", anchorX: 0, anchorY: 60, priority: 1 }),
    ];
    const placed = placeLabels(items, []);
    const ra = placed.get("a");
    const rb = placed.get("b");
    expect(ra).toBeDefined();
    expect(rb).toBeDefined();
    expect(overlaps(ra!, rb!)).toBe(false);
  });

  it("標籤不會壓到其他節點,會換位置", () => {
    // 節點 a 下方正好有另一個節點障礙
    const obstacle: Rect = { x: -22, y: 27, w: 44, h: 44 };
    const placed = placeLabels([item({ id: "a" })], [obstacle]);
    const rect = placed.get("a")!;
    expect(overlaps(rect, obstacle)).toBe(false);
  });

  it("四個方向都擠不下時不顯示", () => {
    // 用四個大障礙把節點圍死
    const big = 500;
    const obstacles: Rect[] = [
      { x: -big / 2, y: 25, w: big, h: big }, // 下
      { x: -big / 2, y: -25 - big, w: big, h: big }, // 上
      { x: 25, y: -big / 2, w: big, h: big }, // 右
      { x: -25 - big, y: -big / 2, w: big, h: big }, // 左
    ];
    const placed = placeLabels([item({ id: "a" })], obstacles);
    expect(placed.has("a")).toBe(false);
  });

  it("alwaysShow 的標籤在全部碰撞時仍以預設位置顯示", () => {
    const big = 500;
    const obstacles: Rect[] = [
      { x: -big / 2, y: 25, w: big, h: big },
      { x: -big / 2, y: -25 - big, w: big, h: big },
      { x: 25, y: -big / 2, w: big, h: big },
      { x: -25 - big, y: -big / 2, w: big, h: big },
    ];
    const placed = placeLabels([item({ id: "a", alwaysShow: true })], obstacles);
    expect(placed.has("a")).toBe(true);
  });

  it("優先權高的先佔位,被擠掉的是低優先權標籤", () => {
    // 兩個節點位置完全相同(極端擁擠),只有一個標籤能放下方
    const items = [
      item({ id: "low", priority: 1 }),
      item({ id: "high", priority: 10 }),
    ];
    const placed = placeLabels(items, []);
    const high = placed.get("high")!;
    expect(high.y).toBeGreaterThan(22); // 高優先權拿到預設(下方)位置
    const low = placed.get("low");
    if (low) {
      expect(overlaps(high, low)).toBe(false);
    }
  });
});
