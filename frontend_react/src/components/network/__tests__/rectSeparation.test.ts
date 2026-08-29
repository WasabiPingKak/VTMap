import { describe, it, expect } from "vitest";
import { resolveRectCollisions, type FootprintNode } from "../rectSeparation";

function makeNode(x: number, y: number, halfWidth = 40): FootprintNode {
  return { x, y, halfWidth, topHeight: 22, bottomHeight: 50 };
}

function hasOverlap(nodes: FootprintNode[]): boolean {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      const overlapX =
        Math.min(a.x + a.halfWidth, b.x + b.halfWidth) -
        Math.max(a.x - a.halfWidth, b.x - b.halfWidth);
      const overlapY =
        Math.min(a.y + a.bottomHeight, b.y + b.bottomHeight) -
        Math.max(a.y - a.topHeight, b.y - b.topHeight);
      if (overlapX > 0 && overlapY > 0) return true;
    }
  }
  return false;
}

describe("resolveRectCollisions", () => {
  it("重疊的兩個節點被推開", () => {
    const nodes = [makeNode(0, 0), makeNode(10, 5)];
    resolveRectCollisions(nodes);
    expect(hasOverlap(nodes)).toBe(false);
  });

  it("完全同座標的節點也能分離", () => {
    const nodes = [makeNode(0, 0), makeNode(0, 0), makeNode(0, 0)];
    resolveRectCollisions(nodes);
    expect(hasOverlap(nodes)).toBe(false);
  });

  it("已無重疊的配置不被移動", () => {
    const nodes = [makeNode(0, 0), makeNode(500, 0)];
    const before = nodes.map((n) => ({ ...n }));
    resolveRectCollisions(nodes);
    expect(nodes[0].x).toBe(before[0].x);
    expect(nodes[1].x).toBe(before[1].x);
  });

  it("密集群(20 個節點擠在一起)收斂到零重疊", () => {
    const nodes: FootprintNode[] = [];
    for (let i = 0; i < 20; i++) {
      nodes.push(makeNode((i % 5) * 15, Math.floor(i / 5) * 12, 30 + (i % 3) * 20));
    }
    resolveRectCollisions(nodes);
    expect(hasOverlap(nodes)).toBe(false);
  });
});
