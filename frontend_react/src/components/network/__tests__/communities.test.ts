import { describe, it, expect } from "vitest";
import { communityColor, detectCommunities } from "../communities";
import type { NetworkGraphData } from "@/types/network";

function makeNode(id: string) {
  return {
    channel_id: id,
    title: id,
    handle: null,
    thumbnail: null,
    in_vtmap: true,
    subscriber_count: null,
    scanned: true,
  };
}

function makeEdge(a: string, b: string, weight = 3) {
  return { a, b, evidence_count: weight, last_seen_video_at: null, evidence: [] };
}

// 兩個緊密三角形,中間只有一條弱連結
const twoClusters: NetworkGraphData = {
  nodes: ["A1", "A2", "A3", "B1", "B2", "B3"].map(makeNode),
  edges: [
    makeEdge("A1", "A2"),
    makeEdge("A2", "A3"),
    makeEdge("A1", "A3"),
    makeEdge("B1", "B2"),
    makeEdge("B2", "B3"),
    makeEdge("B1", "B3"),
    makeEdge("A1", "B1", 1),
  ],
};

describe("detectCommunities", () => {
  it("兩個緊密群各自成社群", () => {
    const communities = detectCommunities(twoClusters);
    expect(communities.get("A1")).toBe(communities.get("A2"));
    expect(communities.get("A2")).toBe(communities.get("A3"));
    expect(communities.get("B1")).toBe(communities.get("B2"));
    expect(communities.get("B2")).toBe(communities.get("B3"));
    expect(communities.get("A1")).not.toBe(communities.get("B1"));
  });

  it("結果可重現(固定種子)", () => {
    const first = detectCommunities(twoClusters);
    const second = detectCommunities(twoClusters);
    expect([...first.entries()]).toEqual([...second.entries()]);
  });

  it("空資料回傳空 Map,孤立節點也有社群編號", () => {
    expect(detectCommunities({ nodes: [], edges: [] }).size).toBe(0);
    const withIsolated = detectCommunities({
      nodes: [makeNode("X"), makeNode("Y")],
      edges: [],
    });
    expect(withIsolated.size).toBe(2);
  });
});

describe("communityColor", () => {
  it("不同社群產生不同色相,同社群穩定", () => {
    expect(communityColor(0, 0.5)).toBe(communityColor(0, 0.5));
    expect(communityColor(0, 0.5)).not.toBe(communityColor(1, 0.5));
    expect(communityColor(3, 0.07)).toMatch(/^hsla\(\d+, 65%, 60%, 0\.07\)$/);
  });
});
