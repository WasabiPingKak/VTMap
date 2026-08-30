/**
 * 關係網路 layout:ForceAtlas2(LinLog + 邊權重)——Gephi 生態的標準做法,
 * 讓關係緊密的社群自然聚攏、群間拉開,搭配 Louvain 社群偵測上色。
 * 之後做「矩形分離」後處理,保證「節點 + 下方標籤」互不重疊
 * (做法參考 VTaxon,邊長允許不均勻)。
 *
 * ego 模式(指定圓心)不改變任何節點位置:同一張力導向佈局上,
 * 以 BFS 分環(圓心=0、直接關係人=1、間接=2、其餘=3 外圍淡化)決定
 * 著色與淡化,相機再拉近到圓心的鄰域。換圓心時世界不重排,
 * 使用者的空間記憶得以保留。
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

/** 縮放的目標:有連線的節點對之間的中位數距離 */
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

/** 穩定的偽隨機角度(力導向的初始位置用) */
function hashAngle(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return ((hash >>> 0) % 3600) * (Math.PI / 1800);
}

/** ForceAtlas2:社群自然聚攏 */
function computeForcePositions(data: NetworkGraphData): { x: number; y: number }[] {
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
  const positions = computeForcePositions(data);

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
