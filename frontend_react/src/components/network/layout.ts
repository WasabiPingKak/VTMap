/**
 * 關係網路 layout,兩種模式共用「矩形分離」後處理,
 * 保證「節點 + 下方標籤」互不重疊(做法參考 VTaxon,邊長允許不均勻)。
 *
 * 全圖模式:ForceAtlas2(LinLog + 邊權重)——Gephi 生態的標準做法,
 * 讓關係緊密的社群自然聚攏、群間拉開,搭配 Louvain 社群偵測上色。
 *
 * ego 模式(指定圓心):以 BFS 分環(圓心=0、直接關係人=1、間接=2、
 * 其餘=3 外圍淡化),用 forceRadial 把各環約束在對應半徑。
 */

import { forceCollide, forceRadial, forceSimulation } from "d3-force";
import type { SimulationNodeDatum } from "d3-force";
import forceAtlas2 from "graphology-layout-forceatlas2";
import type {
  GraphLayout,
  LayoutEdge,
  LayoutNode,
  NetworkGraphData,
} from "@/types/network";
import { buildGraph, detectCommunities } from "./communities";
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

/** 全圖模式縮放的目標:有連線的節點對之間的中位數距離 */
const TARGET_LINKED_DISTANCE = 180;

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

/** 第一個子環的半徑:貼近圓心,拉近時頭像與名字清楚可讀 */
const FIRST_RING_RADIUS = 250;
/** 子環之間的間距(要容得下標籤高度) */
const SUB_RING_GAP = 145;
/** 節點在圓周上的水平間隔 */
const ARC_PADDING = 26;

interface RingPlacement {
  radius: number;
  angle: number;
}

/**
 * 把成員排進一圈圈同心子環:依傳入順序(強度由大到小)填,
 * 一圈塞滿(圓周容不下下一個)就往外開新的一圈。
 * 回傳每個成員的半徑與角度,以及最外圈的半徑。
 */
function packIntoSubRings(
  members: string[],
  halfWidthById: Map<string, number>,
  startRadius: number,
): { placements: Map<string, RingPlacement>; outerRadius: number } {
  const placements = new Map<string, RingPlacement>();
  if (!members.length) return { placements, outerRadius: startRadius };

  const occupied = (id: string) => (halfWidthById.get(id) ?? HEX_RADIUS) * 2 + ARC_PADDING;

  let radius = startRadius;
  let index = 0;
  let subRingIndex = 0;
  while (index < members.length) {
    const capacity = 2 * Math.PI * radius;
    const batch: string[] = [];
    let used = 0;
    while (index < members.length) {
      const need = occupied(members[index]);
      // 每圈至少放一個,避免極寬標籤造成無限外擴
      if (batch.length && used + need > capacity) break;
      batch.push(members[index]);
      used += need;
      index += 1;
    }

    // 同圈成員依實際佔用寬度按比例分配角度(寬的多佔一點,避免擠在一起)
    const total = batch.reduce((sum, id) => sum + occupied(id), 0) || 1;
    // 每圈起始角錯開,避免子環之間連成一直線
    let angle = subRingIndex * 0.9;
    for (const id of batch) {
      const share = (occupied(id) / total) * 2 * Math.PI;
      placements.set(id, { radius, angle: angle + share / 2 });
      angle += share;
    }

    subRingIndex += 1;
    if (index < members.length) radius += SUB_RING_GAP;
  }

  return { placements, outerRadius: radius };
}

/** 穩定的偽隨機角度 */
function hashAngle(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return ((hash >>> 0) % 3600) * (Math.PI / 1800);
}

/**
 * ego 模式:以圓心為原點的同心環佈局。
 *
 * 第一層(直接關係)依關係強度(證據數)由強到弱排序,填進一圈圈子環:
 * 最強的貼近圓心,一圈塞滿才往外開下一圈。距離因此代表關係深淺,
 * 且內圈永遠在「頭像與名字看得清楚」的縮放範圍內。
 * 第二層與外圍接在最外側子環之後。
 */
function computeEgoPositions(
  data: NetworkGraphData,
  centerId: string,
  rings: Map<string, number>,
  halfWidthById: Map<string, number>,
  metrics: { halfWidth: number }[],
): { x: number; y: number }[] {
  const adjacency = buildAdjacency(data);
  const nodeIds = data.nodes.map((n) => n.channel_id);

  // 圓心與各直接關係人的證據數(關係強度)
  const strengthToCenter = new Map<string, number>();
  for (const edge of data.edges) {
    if (edge.a === centerId) strengthToCenter.set(edge.b, edge.evidence_count);
    else if (edge.b === centerId) strengthToCenter.set(edge.a, edge.evidence_count);
  }

  const byRing: string[][] = [[], [], [], []];
  for (const id of nodeIds) byRing[rings.get(id)!].push(id);

  // 第一層:強度由大到小(同強度時 id 排序,確保結果穩定)
  const firstLayer = [...byRing[1]].sort((a, b) => {
    const diff = (strengthToCenter.get(b) ?? 0) - (strengthToCenter.get(a) ?? 0);
    return diff !== 0 ? diff : a.localeCompare(b);
  });
  const first = packIntoSubRings(firstLayer, halfWidthById, FIRST_RING_RADIUS);

  // 第二層:排在第一層最外圈之外,同樣可分成多個子環
  const secondStart = first.outerRadius + SUB_RING_GAP + 40;
  const second = packIntoSubRings(byRing[2], halfWidthById, secondStart);

  const placements = new Map<string, RingPlacement>([...first.placements, ...second.placements]);

  // 第二層節點靠向其第一層鄰居的角度,減少跨環交叉(半徑不動)
  for (const id of byRing[2]) {
    const placement = placements.get(id);
    if (!placement) continue;
    const parents = [...(adjacency.get(id) ?? [])].filter((p) => rings.get(p) === 1);
    const parentAngles = parents
      .map((p) => placements.get(p)?.angle)
      .filter((a): a is number => a !== undefined);
    if (parentAngles.length) {
      // 角度平均要走向量,避免 0/2π 邊界問題
      const x = parentAngles.reduce((s, a) => s + Math.cos(a), 0);
      const y = parentAngles.reduce((s, a) => s + Math.sin(a), 0);
      if (x || y) placement.angle = Math.atan2(y, x);
    }
  }

  // 外圍(無關)節點:同樣以子環打包成有序的淡色殼。
  // 圓周容量必須真的裝得下(不能全部疊在同一圈,否則矩形分離會把
  // 它們炸開成厚球、連帶擠壞內部結構),並與 ego 結構保留明顯空隙。
  const outerStart = second.outerRadius + SUB_RING_GAP + 220;
  const outerSorted = [...byRing[3]].sort((a, b) => hashAngle(a) - hashAngle(b));
  const outer = packIntoSubRings(outerSorted, halfWidthById, outerStart);
  for (const [id, placement] of outer.placements) {
    placements.set(id, placement);
  }
  const fallbackRadius = outer.outerRadius;

  const simNodes: SimNode[] = data.nodes.map((n) => ({ id: n.channel_id }));
  for (const sn of simNodes) {
    if (rings.get(sn.id) === 0) {
      sn.fx = 0;
      sn.fy = 0;
      continue;
    }
    const placement = placements.get(sn.id);
    if (!placement) continue;
    sn.x = Math.cos(placement.angle) * placement.radius;
    sn.y = Math.sin(placement.angle) * placement.radius;
  }

  // 只跑碰撞與環約束(不跑 link 力,否則子環的強度分層會被拉散)
  const sim = forceSimulation(simNodes)
    .force(
      "collide",
      forceCollide((_d, i) => Math.max(metrics[i].halfWidth, HEX_RADIUS) + 12),
    )
    .force(
      "radial",
      forceRadial(
        (d) => placements.get((d as SimNode).id)?.radius ?? fallbackRadius,
        0,
        0,
      ).strength((d) => (rings.get((d as SimNode).id)! >= EGO_OUTER_RING ? 0.6 : 0.95)),
    )
    .stop();

  const ticks = Math.ceil(Math.log(sim.alphaMin()) / Math.log(1 - sim.alphaDecay()));
  sim.tick(ticks);

  return simNodes.map((sn) => ({ x: sn.x ?? 0, y: sn.y ?? 0 }));
}

/** 全圖模式:ForceAtlas2,社群自然聚攏 */
function computeGlobalPositions(data: NetworkGraphData): { x: number; y: number }[] {
  const graph = buildGraph(data);
  // 固定的初始位置,確保結果可重現
  data.nodes.forEach((n, i) => {
    const angle = hashAngle(n.channel_id);
    const radius = 60 + ((i * 137) % 400);
    graph.setNodeAttribute(n.channel_id, "x", Math.cos(angle) * radius);
    graph.setNodeAttribute(n.channel_id, "y", Math.sin(angle) * radius);
  });

  if (graph.size > 0) {
    forceAtlas2.assign(graph, {
      iterations: 300,
      getEdgeWeight: "weight",
      settings: {
        linLogMode: true,
        // strong gravity:把互不相連的小群往中心收攏,避免孤島飛太遠
        gravity: 1,
        strongGravityMode: true,
        scalingRatio: 6,
        edgeWeightInfluence: 1,
        barnesHutOptimize: graph.order > 200,
      },
    });
  }

  const positions = data.nodes.map((n) => ({
    x: graph.getNodeAttribute(n.channel_id, "x") as number,
    y: graph.getNodeAttribute(n.channel_id, "y") as number,
  }));

  // FA2 輸出尺度不固定,縮放到「有連線的節點對中位數距離 = 目標值」
  const indexById = new Map(data.nodes.map((n, i) => [n.channel_id, i]));
  const linkedDistances: number[] = [];
  for (const edge of data.edges) {
    const a = indexById.get(edge.a);
    const b = indexById.get(edge.b);
    if (a === undefined || b === undefined) continue;
    linkedDistances.push(
      Math.hypot(positions[a].x - positions[b].x, positions[a].y - positions[b].y),
    );
  }
  if (linkedDistances.length) {
    linkedDistances.sort((x, y) => x - y);
    const median = linkedDistances[Math.floor(linkedDistances.length / 2)];
    if (median > 0) {
      const scale = Math.min(Math.max(TARGET_LINKED_DISTANCE / median, 0.3), 20);
      for (const p of positions) {
        p.x *= scale;
        p.y *= scale;
      }
    }
  }
  return positions;
}

export function computeLayout(
  data: NetworkGraphData,
  measure?: MeasureFn,
  ego?: EgoOptions,
): GraphLayout {
  const layoutStart =
    typeof performance !== "undefined" ? performance.now() : 0;
  const measureFn = measure ?? createDefaultMeasure();
  const metrics = data.nodes.map((n) => computeLabelMetrics(channelDisplayName(n), measureFn));
  const halfWidthById = new Map(data.nodes.map((n, i) => [n.channel_id, metrics[i].halfWidth]));

  const nodeIds = data.nodes.map((n) => n.channel_id);
  const egoActive = Boolean(ego && nodeIds.includes(ego.centerId));
  const rings = egoActive
    ? assignRings(ego!.centerId, nodeIds, buildAdjacency(data))
    : null;
  const communities = data.nodes.length ? detectCommunities(data) : null;

  const positions = egoActive
    ? computeEgoPositions(data, ego!.centerId, rings!, halfWidthById, metrics)
    : computeGlobalPositions(data);

  // 矩形分離:保證「節點 + 下方標籤」零重疊
  const footprints: FootprintNode[] = positions.map((p, i) => ({
    x: p.x,
    y: p.y,
    halfWidth: metrics[i].halfWidth,
    topHeight: metrics[i].topHeight,
    bottomHeight: metrics[i].bottomHeight,
  }));
  resolveRectCollisions(footprints);

  // ego 模式:分離後把圓心平移回原點(平移不影響零重疊)
  if (egoActive) {
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

  if (import.meta.env?.DEV && typeof performance !== "undefined") {
    console.log(
      `[graph-perf] layout=${(performance.now() - layoutStart).toFixed(0)}ms ` +
        `nodes=${nodes.length} edges=${edges.length} ego=${egoActive}`,
    );
  }

  return {
    nodes,
    edges,
    byId,
    neighbors,
    bounds: { minX, minY, maxX, maxY },
    egoCenterId: egoActive ? ego!.centerId : null,
    rings,
    communities,
  };
}
