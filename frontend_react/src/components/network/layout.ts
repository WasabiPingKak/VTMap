/**
 * 關係網路 layout,兩種模式共用「矩形分離」後處理,
 * 保證「節點 + 下方標籤」互不重疊(做法參考 VTaxon,邊長允許不均勻)。
 *
 * 全圖模式:ForceAtlas2(LinLog + 邊權重)——Gephi 生態的標準做法,
 * 讓關係緊密的社群自然聚攏、群間拉開,搭配 Louvain 社群偵測上色。
 * FA2 位置與社群偵測結果依資料快取,切換 ego 圓心不重算。
 *
 * ego 模式(指定圓心):以 BFS 分環(圓心=0、直接關係人=1、間接=2、
 * 其餘=3 外圍淡化)。半徑 = 關係強度;角度 = 該節點在全圖 FA2 佈局中
 * 相對圓心的真實方位角,ego 視圖因此保留全圖的群組相對關係,
 * 不做任何角度均勻化。
 */

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
const FIRST_RING_RADIUS = 160;
/** 子環之間的間距(要容得下標籤高度;殘餘重疊交給矩形分離) */
const SUB_RING_GAP = 110;
/** 節點在圓周上的水平間隔 */
const ARC_PADDING = 20;
/** ego 結構(兩層內)與外圍殼之間的空隙 */
const SHELL_GAP = 200;

interface RingPlacement {
  radius: number;
  angle: number;
}

/**
 * 把一圈成員放到目標角度上:batch 需已依目標角排序,
 * 由前往後掃描,重疊時往前推開;頭尾繞圈重疊時整體回轉一半。
 * 不做均勻化——節點盡量停在自己的目標方向,保留群組相對關係。
 */
function placeRingByAngle(
  batch: string[],
  radius: number,
  occupied: (id: string) => number,
  target: (id: string) => number,
  placements: Map<string, RingPlacement>,
) {
  if (!batch.length) return;
  const angularWidth = (id: string) => occupied(id) / radius;

  const angles: number[] = [];
  for (let i = 0; i < batch.length; i++) {
    const desired = target(batch[i]);
    if (i === 0) {
      angles.push(desired);
      continue;
    }
    const minAngle = angles[i - 1] + angularWidth(batch[i - 1]) / 2 + angularWidth(batch[i]) / 2;
    angles.push(Math.max(desired, minAngle));
  }
  const overshoot =
    angles[angles.length - 1] +
    angularWidth(batch[batch.length - 1]) / 2 -
    (angles[0] - angularWidth(batch[0]) / 2 + 2 * Math.PI);
  const shift = overshoot > 0 ? overshoot / 2 : 0;
  batch.forEach((id, i) => {
    placements.set(id, { radius, angle: angles[i] - shift });
  });
}

/**
 * 依傳入順序(強度由大到小)填同心子環:
 * 一圈塞滿(圓周容不下下一個)就往外開新的一圈,
 * 同圈成員依目標角度就位。回傳最外圈半徑。
 */
function packIntoSubRings(
  members: string[],
  halfWidthById: Map<string, number>,
  startRadius: number,
  targetAngles: Map<string, number>,
): { placements: Map<string, RingPlacement>; outerRadius: number } {
  const placements = new Map<string, RingPlacement>();
  if (!members.length) return { placements, outerRadius: startRadius };

  const occupied = (id: string) => (halfWidthById.get(id) ?? HEX_RADIUS) * 2 + ARC_PADDING;
  const target = (id: string) => targetAngles.get(id) ?? hashAngle(id);

  let radius = startRadius;
  let index = 0;
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
    batch.sort((a, b) => target(a) - target(b));
    placeRingByAngle(batch, radius, occupied, target, placements);
    if (index < members.length) radius += SUB_RING_GAP;
  }

  return { placements, outerRadius: radius };
}

/**
 * 沒有內外順序意義的成員(第二層、外圍殼):
 * 依目標角度排序後輪流分配到 k 圈,每一圈都涵蓋全方位,
 * 同一個群組因此在內外圈對齊成放射狀楔形。
 */
function packRoundRobinRings(
  members: string[],
  halfWidthById: Map<string, number>,
  startRadius: number,
  targetAngles: Map<string, number>,
): { placements: Map<string, RingPlacement>; outerRadius: number } {
  const placements = new Map<string, RingPlacement>();
  if (!members.length) return { placements, outerRadius: startRadius };

  const occupied = (id: string) => (halfWidthById.get(id) ?? HEX_RADIUS) * 2 + ARC_PADDING;
  const target = (id: string) => targetAngles.get(id) ?? hashAngle(id);

  // 需要幾圈:由內往外累計圓周容量,直到裝得下全部成員
  const totalNeed = members.reduce((sum, id) => sum + occupied(id), 0);
  let ringCount = 1;
  let capacity = 2 * Math.PI * startRadius;
  while (capacity < totalNeed) {
    capacity += 2 * Math.PI * (startRadius + ringCount * SUB_RING_GAP);
    ringCount += 1;
  }

  const sorted = [...members].sort((a, b) => target(a) - target(b) || a.localeCompare(b));
  const batches: string[][] = Array.from({ length: ringCount }, () => []);
  sorted.forEach((id, i) => batches[i % ringCount].push(id));

  let outerRadius = startRadius;
  batches.forEach((batch, ring) => {
    const radius = startRadius + ring * SUB_RING_GAP;
    outerRadius = Math.max(outerRadius, radius);
    placeRingByAngle(batch, radius, occupied, target, placements);
  });

  return { placements, outerRadius };
}

/** 穩定的偽隨機角度(缺全圖位置時的後備) */
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
 * 半徑 = 關係強度:第一層依證據數由強到弱填子環,最強貼近圓心。
 * 角度 = 全圖方位:每個節點取它在全圖 FA2 佈局中相對圓心的方位角,
 * 群組的相對方向與全圖一致,切換檢視時視覺上可對照。
 * 位置由打包直接決定(不跑力學模擬),殘餘重疊交給矩形分離,速度快且確定。
 */
function computeEgoPositions(
  data: NetworkGraphData,
  centerId: string,
  rings: Map<string, number>,
  halfWidthById: Map<string, number>,
  globalPositions: { x: number; y: number }[],
): { x: number; y: number }[] {
  const nodeIds = data.nodes.map((n) => n.channel_id);

  // 目標角度:全圖 FA2 佈局中相對圓心的方位角
  const centerIndex = nodeIds.indexOf(centerId);
  const cx = globalPositions[centerIndex]?.x ?? 0;
  const cy = globalPositions[centerIndex]?.y ?? 0;
  const targetAngles = new Map<string, number>();
  nodeIds.forEach((id, i) => {
    const dx = globalPositions[i].x - cx;
    const dy = globalPositions[i].y - cy;
    targetAngles.set(id, dx === 0 && dy === 0 ? hashAngle(id) : Math.atan2(dy, dx));
  });

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
  const first = packIntoSubRings(firstLayer, halfWidthById, FIRST_RING_RADIUS, targetAngles);

  // 第二層:排在第一層最外圈之外;無內外順序,輪流分配讓每圈涵蓋全方位
  const secondStart = first.outerRadius + SUB_RING_GAP;
  const second = packRoundRobinRings(byRing[2], halfWidthById, secondStart, targetAngles);

  const placements = new Map<string, RingPlacement>([...first.placements, ...second.placements]);

  // 外圍(無關)節點:打包成有序的淡色殼,與 ego 結構保留明顯空隙
  const outerStart = second.outerRadius + SHELL_GAP;
  const outer = packRoundRobinRings(byRing[3], halfWidthById, outerStart, targetAngles);
  for (const [id, placement] of outer.placements) {
    placements.set(id, placement);
  }

  return data.nodes.map((n) => {
    if (rings.get(n.channel_id) === 0) return { x: 0, y: 0 };
    const placement = placements.get(n.channel_id);
    if (!placement) return { x: 0, y: 0 };
    return {
      x: Math.cos(placement.angle) * placement.radius,
      y: Math.sin(placement.angle) * placement.radius,
    };
  });
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

/**
 * 全圖基底(FA2 位置 + Louvain 社群)依資料物件快取:
 * 同一份資料在全圖/各種 ego 圓心之間切換時只算一次。
 */
interface GlobalBasis {
  positions: { x: number; y: number }[];
  communities: Map<string, number> | null;
}
const globalBasisCache = new WeakMap<NetworkGraphData, GlobalBasis>();

function getGlobalBasis(data: NetworkGraphData): GlobalBasis {
  let basis = globalBasisCache.get(data);
  if (!basis) {
    basis = {
      positions: computeGlobalPositions(data),
      communities: data.nodes.length ? detectCommunities(data) : null,
    };
    globalBasisCache.set(data, basis);
  }
  return basis;
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
  const basis = getGlobalBasis(data);

  const positions = egoActive
    ? computeEgoPositions(data, ego!.centerId, rings!, halfWidthById, basis.positions)
    : basis.positions;

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
    communities: basis.communities,
  };
}
