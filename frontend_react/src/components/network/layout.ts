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
 * 依社群分配整圓的扇區,回傳每個節點的目標角度。
 * 同社群的節點固定落在同一個方向的楔形內(扇區寬度 ∝ 成員數),
 * 讓 ego 視圖保留「同群聚同方向」的群組結構。
 */
function computeSectorAngles(
  nodeIds: string[],
  communities: Map<string, number> | null,
): Map<string, number> {
  const targetAngles = new Map<string, number>();
  const communityOf = (id: string) => communities?.get(id) ?? -1;

  const counts = new Map<number, number>();
  for (const id of nodeIds) {
    const community = communityOf(id);
    counts.set(community, (counts.get(community) ?? 0) + 1);
  }
  // 大社群優先分配(順序穩定)
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const total = nodeIds.length || 1;

  const sectorCenter = new Map<number, number>();
  const sectorWidth = new Map<number, number>();
  let cursor = 0;
  for (const [community, count] of ordered) {
    const width = (count / total) * 2 * Math.PI;
    sectorCenter.set(community, cursor + width / 2);
    sectorWidth.set(community, width);
    cursor += width;
  }

  for (const id of nodeIds) {
    const community = communityOf(id);
    const center = sectorCenter.get(community) ?? 0;
    const width = sectorWidth.get(community) ?? 2 * Math.PI;
    // 扇區內用穩定雜湊抖動,避免同群全部疊在同一個角度
    const jitter = (hashAngle(id) / (2 * Math.PI) - 0.5) * width * 0.85;
    targetAngles.set(id, center + jitter);
  }
  return targetAngles;
}

/**
 * 把成員排進一圈圈同心子環:依傳入順序(強度由大到小)填,
 * 一圈塞滿(圓周容不下下一個)就往外開新的一圈。
 * 同圈成員依「目標角度」(社群扇區)排,盡量貼近目標方向,
 * 圓周擁擠時退回按佔用寬度比例分配。
 * 回傳每個成員的半徑與角度,以及最外圈的半徑。
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

    // 依目標角度排序後放置:先放在目標角,前向掃描推開重疊
    batch.sort((a, b) => target(a) - target(b));
    const angularWidth = (id: string) => occupied(id) / radius;

    if (used / capacity > 0.82) {
      // 圓周快滿:按佔用比例分配,起點取第一個成員的目標角(方向大致保留)
      let angle = target(batch[0]);
      for (const id of batch) {
        const share = (occupied(id) / used) * 2 * Math.PI;
        placements.set(id, { radius, angle: angle + share / 2 });
        angle += share;
      }
    } else {
      const angles: number[] = [];
      for (let i = 0; i < batch.length; i++) {
        const desired = target(batch[i]);
        if (i === 0) {
          angles.push(desired);
          continue;
        }
        const minAngle =
          angles[i - 1] + angularWidth(batch[i - 1]) / 2 + angularWidth(batch[i]) / 2;
        angles.push(Math.max(desired, minAngle));
      }
      // 頭尾繞圈重疊時整體回轉一點
      const overshoot =
        angles[angles.length - 1] +
        angularWidth(batch[batch.length - 1]) / 2 -
        (angles[0] - angularWidth(batch[0]) / 2 + 2 * Math.PI);
      const shift = overshoot > 0 ? overshoot / 2 : 0;
      batch.forEach((id, i) => {
        placements.set(id, { radius, angle: angles[i] - shift });
      });
    }

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
 * 半徑 = 關係強度:第一層依證據數由強到弱填子環,最強貼近圓心。
 * 角度 = 社群方向:同社群固定佔同一個扇區,內外圈對齊成放射狀楔形,
 * 保留「同群聚同方向」的群組結構。
 * 位置由打包直接決定(不跑力學模擬),殘餘重疊交給矩形分離,速度快且確定。
 */
function computeEgoPositions(
  data: NetworkGraphData,
  centerId: string,
  rings: Map<string, number>,
  halfWidthById: Map<string, number>,
  communities: Map<string, number> | null,
): { x: number; y: number }[] {
  const nodeIds = data.nodes.map((n) => n.channel_id);
  const targetAngles = computeSectorAngles(nodeIds, communities);

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

  // 第二層:排在第一層最外圈之外,同樣可分成多個子環
  const secondStart = first.outerRadius + SUB_RING_GAP + 40;
  const second = packIntoSubRings(byRing[2], halfWidthById, secondStart, targetAngles);

  const placements = new Map<string, RingPlacement>([...first.placements, ...second.placements]);

  // 外圍(無關)節點:子環打包成有序的淡色殼,與 ego 結構保留明顯空隙。
  // 圓周容量必須真的裝得下,不能全部疊在同一圈。
  const outerStart = second.outerRadius + SUB_RING_GAP + 220;
  const outer = packIntoSubRings(byRing[3], halfWidthById, outerStart, targetAngles);
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
    ? computeEgoPositions(data, ego!.centerId, rings!, halfWidthById, communities)
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
