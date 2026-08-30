/**
 * 關係網路 layout:d3-force 力導向,同步跑完 simulation 後再做「矩形分離」
 * 後處理,保證「節點 + 下方標籤」互不重疊(做法參考 VTaxon,邊長允許不均勻)。
 *
 * 刻意不用 ForceAtlas2:它的 linLog + strong gravity 會把整張圖壓成密實的
 * 圓盤,群組的相對關係在視覺上被抹平。d3-force 的斥力與連線距離讓圖自然
 * 攤開成有枝幹的形狀,看得出誰跟誰成群。
 *
 * ego 模式(指定圓心)不改變任何節點位置:同一張力導向佈局上,
 * 以 BFS 分環(圓心=0、直接關係人=1、間接=2、其餘=3 外圍淡化)決定
 * 著色與淡化,相機再拉近到圓心的鄰域。換圓心時世界不重排,
 * 使用者的空間記憶得以保留。
 */

import {
  forceCollide,
  forceLink,
  forceManyBody,
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
import { detectCommunities } from "./communities";
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

/**
 * d3-force 力導向:連線把認識的人拉近、斥力把不相干的人推開,
 * 座標本身就是世界尺度(連線基準距離 170),不需要事後正規化。
 */
function computeForcePositions(
  data: NetworkGraphData,
  metrics: { halfWidth: number }[],
): { x: number; y: number }[] {
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

  return simNodes.map((sn) => ({ x: sn.x ?? 0, y: sn.y ?? 0 }));
}

/**
 * 佈局基底(分離後的最終座標 + 標籤度量 + Louvain 社群)依資料物件快取。
 * ego 模式不動位置,所以切換圓心時整個基底沿用,只重跑 BFS 分環。
 */
interface LayoutBasis {
  footprints: FootprintNode[];
  metrics: ReturnType<typeof computeLabelMetrics>[];
  communities: Map<string, number> | null;
}
const basisCache = new WeakMap<NetworkGraphData, LayoutBasis>();

function computeBasis(data: NetworkGraphData, measureFn: MeasureFn): LayoutBasis {
  const metrics = data.nodes.map((n) => computeLabelMetrics(channelDisplayName(n), measureFn));
  const positions = computeForcePositions(data, metrics);

  // 矩形分離:保證「節點 + 下方標籤」零重疊
  const footprints: FootprintNode[] = positions.map((p, i) => ({
    x: p.x,
    y: p.y,
    halfWidth: metrics[i].halfWidth,
    topHeight: metrics[i].topHeight,
    bottomHeight: metrics[i].bottomHeight,
  }));
  resolveRectCollisions(footprints);

  return {
    footprints,
    metrics,
    communities: data.nodes.length ? detectCommunities(data) : null,
  };
}

function getBasis(data: NetworkGraphData, measure?: MeasureFn): LayoutBasis {
  // 自訂 measure(測試等)不走快取,避免不同度量共用同一份座標
  if (measure) return computeBasis(data, measure);
  let basis = basisCache.get(data);
  if (!basis) {
    basis = computeBasis(data, createDefaultMeasure());
    basisCache.set(data, basis);
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

  const nodeIds = data.nodes.map((n) => n.channel_id);
  const egoActive = Boolean(ego && nodeIds.includes(ego.centerId));
  const { footprints, metrics, communities } = getBasis(data, measure);

  // ego 模式只改變分環(著色與淡化用),位置一律沿用力導向佈局
  const rings = egoActive
    ? assignRings(ego!.centerId, nodeIds, buildAdjacency(data))
    : null;

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
