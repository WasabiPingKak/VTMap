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

import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceRadial,
  forceSimulation,
} from "d3-force";
import type { SimulationNodeDatum } from "d3-force";
import forceAtlas2 from "graphology-layout-forceatlas2";
import type {
  BakedEdges,
  GraphLayout,
  HitGrid,
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

/** hitGrid 桶邊長:> 2 * (HEX_RADIUS + hit tolerance),查一點只需掃 3×3 桶 */
const HIT_GRID_CELL = 60;
/** hitGrid 座標打包偏移:節點座標實務範圍遠小於 ±(32768 * cell) */
const HIT_GRID_OFFSET = 32768;

/** 把 (cx, cy) 打包成單一整數 key(JS 數字安全整數範圍內) */
export function packHitCell(cx: number, cy: number): number {
  return (cx + HIT_GRID_OFFSET) * 65536 + (cy + HIT_GRID_OFFSET);
}

function buildHitGrid(nodes: LayoutNode[]): HitGrid {
  const cells = new Map<number, number[]>();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const cx = Math.floor(n.x / HIT_GRID_CELL);
    const cy = Math.floor(n.y / HIT_GRID_CELL);
    const key = packHitCell(cx, cy);
    const bucket = cells.get(key);
    if (bucket) bucket.push(i);
    else cells.set(key, [i]);
  }
  return { cellSize: HIT_GRID_CELL, cells };
}

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

/** 穩定的偽隨機角度 */
function hashAngle(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return ((hash >>> 0) % 3600) * (Math.PI / 1800);
}

/** ego 模式:d3-force 分環放射佈局,回傳每個節點的座標(依 data.nodes 順序) */
function computeEgoPositions(
  data: NetworkGraphData,
  centerId: string,
  rings: Map<string, number>,
  halfWidthById: Map<string, number>,
  metrics: { halfWidth: number }[],
): { x: number; y: number }[] {
  const adjacency = buildAdjacency(data);
  const nodeIds = data.nodes.map((n) => n.channel_id);
  const ringRadii = computeRingRadii(rings, halfWidthById);

  const simNodes: SimNode[] = data.nodes.map((n) => ({ id: n.channel_id }));
  const nodeIdSet = new Set(nodeIds);
  const simLinks = data.edges
    .filter((e) => nodeIdSet.has(e.a) && nodeIdSet.has(e.b))
    .map((e) => ({ source: e.a, target: e.b }));

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

  const sim = forceSimulation(simNodes)
    .force(
      "link",
      forceLink(simLinks)
        .id((d) => (d as SimNode).id)
        .strength(0.1),
    )
    .force("charge", forceManyBody().strength(-220))
    .force(
      "collide",
      forceCollide((_d, i) => Math.max(metrics[i].halfWidth, HEX_RADIUS) + 12),
    )
    .force(
      "radial",
      forceRadial(
        (d) => ringRadii[rings.get((d as SimNode).id)!],
        0,
        0,
      ).strength((d) => (rings.get((d as SimNode).id)! >= EGO_OUTER_RING ? 0.5 : 0.9)),
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

/**
 * 全圖模式基底(FA2 位置 + Louvain 社群)依資料物件快取:
 * 同一份資料進頁、離頁再回,只算一次 FA2(~700ms),不再凍結畫面。
 * 自訂 measure(測試)不走快取,避免測試互相污染。
 */
interface GlobalBasis {
  positions: { x: number; y: number }[];
  communities: Map<string, number> | null;
}
const globalBasisCache = new WeakMap<NetworkGraphData, GlobalBasis>();

function getGlobalBasis(data: NetworkGraphData, useCache: boolean): GlobalBasis {
  if (useCache) {
    const cached = globalBasisCache.get(data);
    if (cached) return cached;
  }
  const basis: GlobalBasis = {
    positions: computeGlobalPositions(data),
    communities: data.nodes.length ? detectCommunities(data) : null,
  };
  if (useCache) globalBasisCache.set(data, basis);
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
  const basis = getGlobalBasis(data, !measure);
  const communities = basis.communities;

  const positions = egoActive
    ? computeEgoPositions(data, ego!.centerId, rings!, halfWidthById, metrics)
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

    // 預算幾何(source/target 固定 = 每幀重算純浪費)
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const lenSq = dx * dx + dy * dy;
    const length = Math.sqrt(lenSq) || 1;
    const bow = Math.min(length * 0.1, 36);
    const controlX = (source.x + target.x) / 2 - (dy / length) * bow;
    const controlY = (source.y + target.y) / 2 + (dx / length) * bow;

    const width = Math.min(1 + edge.evidence_count * 0.6, 5);
    const widthBucket = Math.round(width * 2) / 2;

    // ego 淡化狀態:兩端都在外圍 → 2(渲染時直接跳過);一端在外圍 → 1;兩端都亮 → 0
    let egoDim: 0 | 1 | 2 = 0;
    if (rings) {
      const outerA = rings.get(edge.a) === EGO_OUTER_RING ? 1 : 0;
      const outerB = rings.get(edge.b) === EGO_OUTER_RING ? 1 : 0;
      egoDim = (outerA + outerB) as 0 | 1 | 2;
    }

    edges.push({
      edge,
      source,
      target,
      controlX,
      controlY,
      lenSq,
      boxMinX: Math.min(source.x, target.x),
      boxMinY: Math.min(source.y, target.y),
      boxMaxX: Math.max(source.x, target.x),
      boxMaxY: Math.max(source.y, target.y),
      widthBucket,
      egoDim,
    });
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

  // 把「全部邊的幾何」預烘進 per-widthBucket Path2D,渲染時一次 stroke 畫完取代 per-frame iterate。
  // base:alpha 依 focus 狀態變(EDGE_ALPHA 或 EDGE_DIM_ALPHA);
  // dim:ego 外圍相關,alpha 固定 EDGE_DIM_ALPHA。
  let bakedEdges: BakedEdges | null = null;
  if (typeof Path2D !== "undefined") {
    const base = new Map<number, Path2D>();
    const dim = rings ? new Map<number, Path2D>() : null;
    for (const le of edges) {
      const bucket = dim && le.egoDim > 0 ? dim : base;
      let p = bucket.get(le.widthBucket);
      if (!p) {
        p = new Path2D();
        bucket.set(le.widthBucket, p);
      }
      p.moveTo(le.source.x, le.source.y);
      p.quadraticCurveTo(le.controlX, le.controlY, le.target.x, le.target.y);
    }
    bakedEdges = { base, dim };
  }

  // 每個節點的相連邊索引(hover/focus overlay 用,避免掃全表)
  const edgesByNode = new Map<string, LayoutEdge[]>();
  for (const le of edges) {
    const a = edgesByNode.get(le.edge.a);
    if (a) a.push(le);
    else edgesByNode.set(le.edge.a, [le]);
    const b = edgesByNode.get(le.edge.b);
    if (b) b.push(le);
    else edgesByNode.set(le.edge.b, [le]);
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
    hitGrid: buildHitGrid(nodes),
    bakedEdges,
    edgesByNode,
  };
}
