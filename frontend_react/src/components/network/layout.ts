/**
 * 力導向 layout:同步跑完 simulation 後,再做矩形分離後處理,
 * 保證「節點 + 下方標籤」互不重疊(做法參考 VTaxon,邊長允許不均勻)。
 *
 * ego 模式(指定圓心):以 BFS 分環(圓心=0、直接關係人=1、間接=2、
 * 其餘=3 外圍淡化),用 forceRadial 把各環約束在對應半徑,矩形分離照常
 * 套用,標籤零重疊的保證在 ego 模式同樣成立。
 */

import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceRadial,
  forceSimulation,
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

export interface EgoOptions {
  centerId: string;
}

/** 外圍(與圓心兩層內無關)的環編號 */
export const EGO_OUTER_RING = 3;

function buildAdjacency(data: NetworkGraphData): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  const ids = new Set(data.nodes.map((n) => n.channel_id));
  for (const edge of data.edges) {
    if (!ids.has(edge.a) || !ids.has(edge.b)) continue;
    if (!adjacency.has(edge.a)) adjacency.set(edge.a, new Set());
    if (!adjacency.has(edge.b)) adjacency.set(edge.b, new Set());
    adjacency.get(edge.a)!.add(edge.b);
    adjacency.get(edge.b)!.add(edge.a);
  }
  return adjacency;
}

/** BFS 分環:圓心 0、直接 1、間接 2,其他一律歸為外圍 */
function assignRings(
  centerId: string,
  nodeIds: string[],
  adjacency: Map<string, Set<string>>,
): Map<string, number> {
  const rings = new Map<string, number>();
  rings.set(centerId, 0);
  let frontier = [centerId];
  for (let ring = 1; ring <= 2; ring++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (!rings.has(neighbor)) {
          rings.set(neighbor, ring);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
  }
  for (const id of nodeIds) {
    if (!rings.has(id)) rings.set(id, EGO_OUTER_RING);
  }
  return rings;
}

/** 依各環成員的佔用寬度計算環半徑(圓周要塞得下所有成員) */
function computeRingRadii(
  rings: Map<string, number>,
  halfWidthById: Map<string, number>,
): number[] {
  const circumferenceNeed = [0, 0, 0, 0];
  for (const [id, ring] of rings) {
    if (ring === 0) continue;
    circumferenceNeed[ring] += (halfWidthById.get(id) ?? HEX_RADIUS) * 2 + 28;
  }
  const radii = [0, 0, 0, 0];
  radii[1] = Math.max(220, (circumferenceNeed[1] / (2 * Math.PI)) * 1.15);
  radii[2] = Math.max(radii[1] + 190, (circumferenceNeed[2] / (2 * Math.PI)) * 1.1);
  radii[3] = Math.max(radii[2] + 240, (circumferenceNeed[3] / (2 * Math.PI)) * 1.05);
  return radii;
}

/** 穩定的偽隨機角度(外圍節點用) */
function hashAngle(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return ((hash >>> 0) % 3600) * (Math.PI / 1800);
}

export function computeLayout(
  data: NetworkGraphData,
  measure?: MeasureFn,
  ego?: EgoOptions,
): GraphLayout {
  const measureFn = measure ?? createDefaultMeasure();
  const metrics = data.nodes.map((n) => computeLabelMetrics(channelDisplayName(n), measureFn));
  const halfWidthById = new Map(
    data.nodes.map((n, i) => [n.channel_id, metrics[i].halfWidth]),
  );

  const adjacency = buildAdjacency(data);
  const nodeIds = data.nodes.map((n) => n.channel_id);
  const egoActive = Boolean(ego && nodeIds.includes(ego.centerId));
  const rings = egoActive ? assignRings(ego!.centerId, nodeIds, adjacency) : null;
  const ringRadii = rings ? computeRingRadii(rings, halfWidthById) : null;

  const simNodes: SimNode[] = data.nodes.map((n) => ({ id: n.channel_id }));
  const nodeIdSet = new Set(nodeIds);
  const simLinks = data.edges
    .filter((e) => nodeIdSet.has(e.a) && nodeIdSet.has(e.b))
    .map((e) => ({ source: e.a, target: e.b, evidence: e.evidence_count }));

  // ego 模式:預先把節點放在目標環上(圓心固定於原點)
  if (rings && ringRadii) {
    const byRing: string[][] = [[], [], [], []];
    for (const id of nodeIds) byRing[rings.get(id)!].push(id);

    const angleById = new Map<string, number>();
    byRing[1].forEach((id, i) => {
      angleById.set(id, (i / Math.max(byRing[1].length, 1)) * 2 * Math.PI);
    });
    for (const id of byRing[2]) {
      // 靠向第一環父節點的平均角度,減少跨環交叉
      const parents = [...(adjacency.get(id) ?? [])].filter((p) => rings.get(p) === 1);
      if (parents.length) {
        const angles = parents.map((p) => angleById.get(p) ?? 0);
        angleById.set(id, angles.reduce((s, a) => s + a, 0) / angles.length + hashAngle(id) * 0.05);
      } else {
        angleById.set(id, hashAngle(id));
      }
    }
    for (const id of byRing[3]) angleById.set(id, hashAngle(id));

    for (const sn of simNodes) {
      const ring = rings.get(sn.id)!;
      if (ring === 0) {
        sn.fx = 0;
        sn.fy = 0;
        continue;
      }
      const angle = angleById.get(sn.id) ?? 0;
      sn.x = Math.cos(angle) * ringRadii[ring];
      sn.y = Math.sin(angle) * ringRadii[ring];
    }
  }

  const sim = forceSimulation(simNodes)
    .force(
      "link",
      forceLink(simLinks)
        .id((d) => (d as SimNode).id)
        // 證據越多的關係拉得越近;基準距離要容得下上下兩組「節點+標籤」
        .distance((l) => 170 - Math.min(40, (l as { evidence: number }).evidence * 8))
        .strength(egoActive ? 0.1 : 0.5),
    )
    .force("charge", forceManyBody().strength(egoActive ? -220 : -420))
    // 用標籤半寬當碰撞半徑,先在 force 階段撐開水平空間
    .force(
      "collide",
      forceCollide((_d, i) => Math.max(metrics[i].halfWidth, HEX_RADIUS) + 12),
    );

  if (rings && ringRadii) {
    sim.force(
      "radial",
      forceRadial(
        (d) => ringRadii[rings.get((d as SimNode).id)!],
        0,
        0,
      ).strength((d) => (rings.get((d as SimNode).id)! >= EGO_OUTER_RING ? 0.5 : 0.9)),
    );
  } else {
    sim.force("x", forceX(0).strength(0.05)).force("y", forceY(0).strength(0.05));
  }
  sim.stop();

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

  // ego 模式:分離後把圓心平移回原點(平移不影響零重疊)
  if (rings && egoActive) {
    const centerIndex = nodeIds.indexOf(ego!.centerId);
    const dx = footprints[centerIndex].x;
    const dy = footprints[centerIndex].y;
    for (const fp of footprints) {
      fp.x -= dx;
      fp.y -= dy;
    }
  }

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

  return {
    nodes,
    edges,
    byId,
    neighbors,
    bounds: { minX, minY, maxX, maxY },
    egoCenterId: egoActive ? ego!.centerId : null,
    rings,
  };
}
