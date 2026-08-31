import { describe, it, expect } from "vitest";
import { computeLayout } from "../layout";
import { hitTest, HEX_RADIUS } from "../renderers";
import type { NetworkGraphData } from "@/types/network";

const data: NetworkGraphData = {
  nodes: [
    { channel_id: "UC_a", title: "A", handle: null, thumbnail: null, in_vtmap: true },
    { channel_id: "UC_b", title: "B", handle: null, thumbnail: null, in_vtmap: true },
    { channel_id: "UC_c", title: "C", handle: null, thumbnail: null, in_vtmap: true },
    { channel_id: "UC_d", title: "D", handle: null, thumbnail: null, in_vtmap: true },
  ],
  edges: [
    { a: "UC_a", b: "UC_b", evidence_count: 1, last_seen_video_at: null, evidence: [] },
    { a: "UC_a", b: "UC_c", evidence_count: 1, last_seen_video_at: null, evidence: [] },
    { a: "UC_c", b: "UC_d", evidence_count: 1, last_seen_video_at: null, evidence: [] },
  ],
};

describe("hitTest", () => {
  it("點在節點中心會命中該節點", () => {
    const layout = computeLayout(data);
    for (const n of layout.nodes) {
      const hit = hitTest(layout, n.x, n.y);
      expect(hit?.node.channel_id).toBe(n.node.channel_id);
    }
  });

  it("點在容差圓外(HEX_RADIUS + 4 之外)不會命中", () => {
    const layout = computeLayout(data);
    const n = layout.nodes[0];
    const beyond = HEX_RADIUS + 20;
    expect(hitTest(layout, n.x + beyond, n.y)).toBeNull();
    expect(hitTest(layout, n.x, n.y + beyond)).toBeNull();
  });

  it("空無節點的區域回 null", () => {
    const layout = computeLayout(data);
    expect(hitTest(layout, 99999, 99999)).toBeNull();
  });

  it("負座標區域也能命中", () => {
    const layout = computeLayout(data);
    const n = layout.nodes.find((x) => x.x < 0 || x.y < 0);
    if (!n) return;
    expect(hitTest(layout, n.x, n.y)?.node.channel_id).toBe(n.node.channel_id);
  });

  it("跨鄰近網格桶也能命中", () => {
    // 每個節點的座標會落在不同的 hitGrid 桶內,測試 3×3 鄰桶掃描能覆蓋
    const layout = computeLayout(data);
    for (const n of layout.nodes) {
      // 在節點邊緣(HEX_RADIUS - 1 處)取點,仍應命中
      const edge = HEX_RADIUS - 1;
      const hit = hitTest(layout, n.x + edge, n.y);
      expect(hit?.node.channel_id).toBe(n.node.channel_id);
    }
  });
});
