import { describe, it, expect } from "vitest";
import { computeLayout } from "../layout";
import type { NetworkGraphData } from "@/types/network";

const data: NetworkGraphData = {
  nodes: [
    { channel_id: "UC_a", title: "A", handle: null, thumbnail: null, in_vtmap: true },
    { channel_id: "UC_b", title: "B", handle: null, thumbnail: null, in_vtmap: false },
    { channel_id: "UC_c", title: "C", handle: null, thumbnail: null, in_vtmap: true },
  ],
  edges: [
    { a: "UC_a", b: "UC_b", evidence_count: 2, last_seen_video_at: null, evidence: [] },
    { a: "UC_a", b: "UC_c", evidence_count: 1, last_seen_video_at: null, evidence: [] },
  ],
};

describe("computeLayout", () => {
  it("為每個節點產生座標並建立索引", () => {
    const layout = computeLayout(data);
    expect(layout.nodes).toHaveLength(3);
    expect(layout.byId.size).toBe(3);
    for (const n of layout.nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });

  it("建立無向鄰接表", () => {
    const layout = computeLayout(data);
    expect(layout.neighbors.get("UC_a")).toEqual(new Set(["UC_b", "UC_c"]));
    expect(layout.neighbors.get("UC_b")).toEqual(new Set(["UC_a"]));
    expect(layout.neighbors.get("UC_c")).toEqual(new Set(["UC_a"]));
  });

  it("力導向會把節點分開(不重疊在原點)", () => {
    const layout = computeLayout(data);
    const positions = new Set(layout.nodes.map((n) => `${n.x.toFixed(1)},${n.y.toFixed(1)}`));
    expect(positions.size).toBe(3);
  });

  it("bounds 涵蓋所有節點", () => {
    const layout = computeLayout(data);
    for (const n of layout.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(layout.bounds.minX);
      expect(n.x).toBeLessThanOrEqual(layout.bounds.maxX);
      expect(n.y).toBeGreaterThanOrEqual(layout.bounds.minY);
      expect(n.y).toBeLessThanOrEqual(layout.bounds.maxY);
    }
  });

  it("空資料不會噴錯", () => {
    const layout = computeLayout({ nodes: [], edges: [] });
    expect(layout.nodes).toHaveLength(0);
    expect(layout.edges).toHaveLength(0);
  });

  it("忽略指向不存在節點的邊", () => {
    const layout = computeLayout({
      nodes: [{ channel_id: "UC_a", title: "A", handle: null, thumbnail: null, in_vtmap: true }],
      edges: [{ a: "UC_a", b: "UC_ghost", evidence_count: 1, last_seen_video_at: null, evidence: [] }],
    });
    expect(layout.edges).toHaveLength(0);
  });
});
