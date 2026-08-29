/**
 * 力導向 layout:載入資料後同步跑完 simulation,輸出固定座標。
 * 圖規模為數百節點,一次算完(< 100ms 等級)比持續動畫更穩定省電。
 */

import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceX,
  forceY,
} from "d3-force";
import type { SimulationNodeDatum } from "d3-force";
import type {
  GraphLayout,
  LayoutEdge,
  LayoutNode,
  NetworkGraphData,
} from "@/types/network";

interface SimNode extends SimulationNodeDatum {
  id: string;
}

export function computeLayout(data: NetworkGraphData): GraphLayout {
  const simNodes: SimNode[] = data.nodes.map((n) => ({ id: n.channel_id }));
  const nodeIds = new Set(simNodes.map((n) => n.id));
  const simLinks = data.edges
    .filter((e) => nodeIds.has(e.a) && nodeIds.has(e.b))
    .map((e) => ({ source: e.a, target: e.b, evidence: e.evidence_count }));

  const sim = forceSimulation(simNodes)
    .force(
      "link",
      forceLink(simLinks)
        .id((d) => (d as SimNode).id)
        // 證據越多的關係拉得越近
        .distance((l) => 120 - Math.min(40, (l as { evidence: number }).evidence * 8))
        .strength(0.6),
    )
    .force("charge", forceManyBody().strength(-380))
    .force("collide", forceCollide(34))
    .force("x", forceX(0).strength(0.05))
    .force("y", forceY(0).strength(0.05))
    .stop();

  // 手動跑完 simulation(次數參考 d3 預設 alpha 衰減至穩定所需)
  const ticks = Math.ceil(
    Math.log(sim.alphaMin()) / Math.log(1 - sim.alphaDecay()),
  );
  sim.tick(ticks);

  const byId = new Map<string, LayoutNode>();
  const nodes: LayoutNode[] = data.nodes.map((node, i) => {
    const layoutNode: LayoutNode = {
      node,
      x: simNodes[i].x ?? 0,
      y: simNodes[i].y ?? 0,
    };
    byId.set(node.channel_id, layoutNode);
    return layoutNode;
  });

  const neighbors = new Map<string, Set<string>>();
  const edges: LayoutEdge[] = [];
  for (const edge of data.edges) {
    const source = byId.get(edge.a);
    const target = byId.get(edge.b);
    if (!source || !target) continue;
    edges.push({ edge, source, target });
    if (!neighbors.has(edge.a)) neighbors.set(edge.a, new Set());
    if (!neighbors.has(edge.b)) neighbors.set(edge.b, new Set());
    neighbors.get(edge.a)!.add(edge.b);
    neighbors.get(edge.b)!.add(edge.a);
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x > maxX) maxX = n.x;
    if (n.y > maxY) maxY = n.y;
  }
  if (!nodes.length) {
    minX = minY = maxX = maxY = 0;
  }

  return { nodes, edges, byId, neighbors, bounds: { minX, minY, maxX, maxY } };
}
