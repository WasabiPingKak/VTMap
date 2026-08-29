/**
 * 力導向 layout:同步跑完 simulation 後,再做矩形分離後處理,
 * 保證「節點 + 下方標籤」互不重疊(做法參考 VTaxon,邊長允許不均勻)。
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
import { channelDisplayName } from "./displayName";
import {
  computeLabelMetrics,
  createDefaultMeasure,
  HEX_RADIUS,
  type MeasureFn,
} from "./labelMetrics";
import { resolveRectCollisions, type FootprintNode } from "./rectSeparation";

interface SimNode extends SimulationNodeDatum {
  id: string;
}

export function computeLayout(data: NetworkGraphData, measure?: MeasureFn): GraphLayout {
  const measureFn = measure ?? createDefaultMeasure();
  const metrics = data.nodes.map((n) => computeLabelMetrics(channelDisplayName(n), measureFn));

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
        // 證據越多的關係拉得越近;基準距離要容得下上下兩組「節點+標籤」
        .distance((l) => 170 - Math.min(40, (l as { evidence: number }).evidence * 8))
        .strength(0.5),
    )
    .force("charge", forceManyBody().strength(-420))
    // 用標籤半寬當碰撞半徑,先在 force 階段撐開水平空間
    .force(
      "collide",
      forceCollide((_d, i) => Math.max(metrics[i].halfWidth, HEX_RADIUS) + 12),
    )
    .force("x", forceX(0).strength(0.05))
    .force("y", forceY(0).strength(0.05))
    .stop();

  const ticks = Math.ceil(Math.log(sim.alphaMin()) / Math.log(1 - sim.alphaDecay()));
  sim.tick(ticks);

  // 矩形分離:保證「節點 + 下方標籤」零重疊
  const footprints: FootprintNode[] = simNodes.map((sn, i) => ({
    x: sn.x ?? 0,
    y: sn.y ?? 0,
    halfWidth: metrics[i].halfWidth,
    topHeight: metrics[i].topHeight,
    bottomHeight: metrics[i].bottomHeight,
  }));
  resolveRectCollisions(footprints);

  const byId = new Map<string, LayoutNode>();
  const nodes: LayoutNode[] = data.nodes.map((node, i) => {
    const layoutNode: LayoutNode = {
      node,
      x: footprints[i].x,
      y: footprints[i].y,
      labelLines: metrics[i].lines,
      labelHalfWidth: metrics[i].halfWidth,
      labelBottomHeight: metrics[i].bottomHeight,
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
    minX = Math.min(minX, n.x - n.labelHalfWidth);
    maxX = Math.max(maxX, n.x + n.labelHalfWidth);
    minY = Math.min(minY, n.y - HEX_RADIUS);
    maxY = Math.max(maxY, n.y + n.labelBottomHeight);
  }
  if (!nodes.length) {
    minX = minY = maxX = maxY = 0;
  }

  return { nodes, edges, byId, neighbors, bounds: { minX, minY, maxX, maxY } };
}
