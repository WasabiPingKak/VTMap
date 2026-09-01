import { describe, it, expect } from "vitest";
import { computeLayout, EGO_OUTER_RING } from "../layout";
import type { NetworkGraphData } from "@/types/network";

const data: NetworkGraphData = {
  nodes: [
    { channel_id: "UC_a", title: "A", handle: null, thumbnail: null, in_vtmap: true, subscriber_count: null, scanned: true },
    { channel_id: "UC_b", title: "B", handle: null, thumbnail: null, in_vtmap: false, subscriber_count: null, scanned: true },
    { channel_id: "UC_c", title: "C", handle: null, thumbnail: null, in_vtmap: true, subscriber_count: null, scanned: true },
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
      nodes: [{ channel_id: "UC_a", title: "A", handle: null, thumbnail: null, in_vtmap: true, subscriber_count: null, scanned: true }],
      edges: [{ a: "UC_a", b: "UC_ghost", evidence_count: 1, last_seen_video_at: null, evidence: [] }],
    });
    expect(layout.edges).toHaveLength(0);
  });

  it("密集圖經 layout 後「節點+下方標籤」零重疊", () => {
    // 20 個長名字節點全部連到中心,模擬密集 hub
    const names = [
      "王顧採 Ch. 六埕順揚宮 主委",
      "Momiji Ch. 沐沐シノもみじ",
      "蒼心・翟普瑞薩",
    ];
    const nodes = Array.from({ length: 20 }, (_, i) => ({
      channel_id: `UC_${i}`,
      title: `${names[i % names.length]}${i}`,
      handle: null,
      thumbnail: null,
      in_vtmap: true,
      subscriber_count: null,
      scanned: true,
    }));
    const edges = nodes.slice(1).map((n) => ({
      a: "UC_0",
      b: n.channel_id,
      evidence_count: 3,
      last_seen_video_at: null,
      evidence: [],
    }));

    const layout = computeLayout({ nodes, edges });

    for (let i = 0; i < layout.nodes.length; i++) {
      for (let j = i + 1; j < layout.nodes.length; j++) {
        const a = layout.nodes[i];
        const b = layout.nodes[j];
        const overlapX =
          Math.min(a.x + a.labelHalfWidth, b.x + b.labelHalfWidth) -
          Math.max(a.x - a.labelHalfWidth, b.x - b.labelHalfWidth);
        const overlapY =
          Math.min(a.y + a.labelBottomHeight, b.y + b.labelBottomHeight) -
          Math.max(a.y - 22, b.y - 22);
        expect(overlapX > 0 && overlapY > 0).toBe(false);
      }
    }
  });
});

describe("computeLayout ego 模式", () => {
  // A - B - C - D 鏈狀 + 孤立節點 E
  const egoData: NetworkGraphData = {
    nodes: ["A", "B", "C", "D", "E"].map((id) => ({
      channel_id: `UC_${id}`,
      title: `頻道${id}`,
      handle: null,
      thumbnail: null,
      in_vtmap: true,
      subscriber_count: null,
      scanned: true,
    })),
    edges: [
      { a: "UC_A", b: "UC_B", evidence_count: 1, last_seen_video_at: null, evidence: [] },
      { a: "UC_B", b: "UC_C", evidence_count: 1, last_seen_video_at: null, evidence: [] },
      { a: "UC_C", b: "UC_D", evidence_count: 1, last_seen_video_at: null, evidence: [] },
    ],
  };

  it("BFS 分環:圓心 0、直接 1、間接 2、隔三層 3、其餘外圍", () => {
    const layout = computeLayout(egoData, undefined, { centerId: "UC_A" });
    expect(layout.egoCenterId).toBe("UC_A");
    expect(layout.rings?.get("UC_A")).toBe(0);
    expect(layout.rings?.get("UC_B")).toBe(1);
    expect(layout.rings?.get("UC_C")).toBe(2);
    expect(layout.rings?.get("UC_D")).toBe(3);
    expect(layout.rings?.get("UC_E")).toBe(EGO_OUTER_RING);
  });

  it("圓心固定在原點,環半徑由內而外遞增", () => {
    const layout = computeLayout(egoData, undefined, { centerId: "UC_A" });
    const center = layout.byId.get("UC_A")!;
    expect(Math.abs(center.x)).toBeLessThan(1);
    expect(Math.abs(center.y)).toBeLessThan(1);

    const dist = (id: string) => {
      const n = layout.byId.get(id)!;
      return Math.hypot(n.x - center.x, n.y - center.y);
    };
    expect(dist("UC_B")).toBeLessThan(dist("UC_C"));
    expect(dist("UC_C")).toBeLessThan(dist("UC_D"));
  });

  it("圓心不存在時退回一般全圖模式", () => {
    const layout = computeLayout(egoData, undefined, { centerId: "UC_ghost" });
    expect(layout.egoCenterId).toBeNull();
    expect(layout.rings).toBeNull();
  });

  it("ego 模式同樣保證「節點+下方標籤」零重疊", () => {
    const nodes = Array.from({ length: 15 }, (_, i) => ({
      channel_id: `UC_${i}`,
      title: `很長的頻道名稱測試用${i}`,
      handle: null,
      thumbnail: null,
      in_vtmap: true,
      subscriber_count: null,
      scanned: true,
    }));
    const edges = nodes.slice(1, 9).map((n) => ({
      a: "UC_0",
      b: n.channel_id,
      evidence_count: 2,
      last_seen_video_at: null,
      evidence: [],
    }));
    const layout = computeLayout({ nodes, edges }, undefined, { centerId: "UC_0" });

    for (let i = 0; i < layout.nodes.length; i++) {
      for (let j = i + 1; j < layout.nodes.length; j++) {
        const a = layout.nodes[i];
        const b = layout.nodes[j];
        const overlapX =
          Math.min(a.x + a.labelHalfWidth, b.x + b.labelHalfWidth) -
          Math.max(a.x - a.labelHalfWidth, b.x - b.labelHalfWidth);
        const overlapY =
          Math.min(a.y + a.labelBottomHeight, b.y + b.labelBottomHeight) -
          Math.max(a.y - 22, b.y - 22);
        expect(overlapX > 0 && overlapY > 0).toBe(false);
      }
    }
  });
});
