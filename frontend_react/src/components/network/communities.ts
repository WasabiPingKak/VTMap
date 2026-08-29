/**
 * 社群偵測(Louvain)與社群色彩。
 * 使用固定種子的偽隨機數,同一份資料每次分群結果一致。
 */

import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import type { NetworkGraphData } from "@/types/network";

/** mulberry32:可種子化的偽隨機數產生器 */
function seededRng(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildGraph(data: NetworkGraphData): Graph {
  const graph = new Graph({ type: "undirected", multi: false });
  for (const node of data.nodes) {
    graph.addNode(node.channel_id);
  }
  for (const edge of data.edges) {
    if (!graph.hasNode(edge.a) || !graph.hasNode(edge.b)) continue;
    if (graph.hasEdge(edge.a, edge.b)) continue;
    graph.addEdge(edge.a, edge.b, { weight: edge.evidence_count });
  }
  return graph;
}

/** 回傳 channel_id → 社群編號(編號重新映射為 0..n,依社群大小排序) */
export function detectCommunities(data: NetworkGraphData): Map<string, number> {
  const result = new Map<string, number>();
  if (!data.nodes.length) return result;

  const graph = buildGraph(data);
  const raw = louvain(graph, { rng: seededRng(20260830), getEdgeWeight: "weight" });

  // 依社群大小重新編號,讓大社群拿到小編號(色相穩定)
  const sizes = new Map<number, number>();
  for (const id of Object.keys(raw)) {
    sizes.set(raw[id], (sizes.get(raw[id]) ?? 0) + 1);
  }
  const ordered = [...sizes.entries()].sort((x, y) => y[1] - x[1]).map(([c]) => c);
  const remap = new Map(ordered.map((c, i) => [c, i]));

  for (const [id, community] of Object.entries(raw)) {
    result.set(id, remap.get(community)!);
  }
  return result;
}

/** 社群色:黃金角色相輪替,固定飽和度/亮度 */
export function communityColor(index: number, alpha: number): string {
  const hue = Math.round((index * 137.508) % 360);
  return `hsla(${hue}, 65%, 60%, ${alpha})`;
}
