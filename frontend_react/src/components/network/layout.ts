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

/**
 * ego 模式的三種佈局:
 * - rings:同心環 + 硬性徑向分帶(距離語意);目前的預設
 * - force:d3-force 圓心固定,其他自然聚合(社群語意)
 * - sunburst:radial tree,hop1 均分扇區,hop2/3 落在 parent 扇區內(親子語意)
 */
export type EgoLayoutMode = "rings" | "force" | "sunburst";

export interface EgoOptions {
  centerId: string;
  /** 佈局模式,預設 rings */
  mode?: EgoLayoutMode;
}

/** ego 模式可從 UI 微調的 layout 參數,全部保留現行預設值 */
export interface LayoutTuning {
  /** forceLink 強度(0.01–1.0),控制有邊節點的互拉 */
  linkStrength: number;
  /** forceManyBody 強度(-1000 到 -50),越負互斥越強 */
  chargeStrength: number;
  /** forceRadial 強度(0.1–2.0),hop1/hop2 環半徑錨定強度 */
  radialStrength: number;
  /** forceCollide 額外 padding(0–50px),節點+標籤最小間距 */
  collidePadding: number;
  /** 環與環的最小間距(0–200px) */
  bandGap: number;
  /** hop1 半徑上限的倍率(乘上 ringRadii[1],0.5–2.0) */
  hop1CapMultiplier: number;
  /** hop2 半徑上限的倍率(乘上 ringRadii[2],0.5–2.0) */
  hop2CapMultiplier: number;
  /** hop3 半徑上限的倍率(乘上 ringRadii[3],0.5–2.0) */
  hop3CapMultiplier: number;
  /** 外圍(灰點)半徑上限的倍率(乘上 ringRadii[4],0.3–2.0);< 1 可把灰點拉近 */
  outerCapMultiplier: number;
}

export const DEFAULT_TUNING: LayoutTuning = {
  linkStrength: 0.04,
  chargeStrength: -220,
  radialStrength: 0.9,
  collidePadding: 12,
  bandGap: 60,
  hop1CapMultiplier: 0.75,
  hop2CapMultiplier: 0.6,
  hop3CapMultiplier: 0.6,
  outerCapMultiplier: 1,
};

/** 外圍(與圓心三層內無關)的環編號 */
export const EGO_OUTER_RING = 4;

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

/** BFS 分環:圓心 0、直接 1、間接 2、隔三層 3,其他一律歸為外圍 */
function assignRings(
  centerId: string,
  nodeIds: string[],
  adjacency: Map<string, Set<string>>,
): Map<string, number> {
  const rings = new Map<string, number>();
  rings.set(centerId, 0);
  let frontier = [centerId];
  for (let ring = 1; ring <= 3; ring++) {
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
  const circumferenceNeed = [0, 0, 0, 0, 0];
  for (const [id, ring] of rings) {
    if (ring === 0) continue;
    circumferenceNeed[ring] += (halfWidthById.get(id) ?? HEX_RADIUS) * 2 + 28;
  }
  const radii = [0, 0, 0, 0, 0];
  radii[1] = Math.max(220, (circumferenceNeed[1] / (2 * Math.PI)) * 1.15);
  radii[2] = Math.max(radii[1] + 190, (circumferenceNeed[2] / (2 * Math.PI)) * 1.1);
  radii[3] = Math.max(radii[2] + 190, (circumferenceNeed[3] / (2 * Math.PI)) * 1.08);
  radii[4] = Math.max(radii[3] + 240, (circumferenceNeed[4] / (2 * Math.PI)) * 1.05);
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

/**
 * ego 模式初始角度:對 hop1+hop2 子圖跑 Louvain,依社群大小切扇區,
 * 同社群節點放在同扇區、不同社群拉開,避免 hop2 全擠一坨。
 * 社群大小決定扇區占比(至少 15°,避免小社群變成一個點)。
 */
function computeCommunitySectorAngles(
  data: NetworkGraphData,
  rings: Map<string, number>,
): Map<string, number> {
  const inSub = (id: string): boolean => {
    const r = rings.get(id);
    return r === 1 || r === 2 || r === 3;
  };
  const subNodes = data.nodes.filter((n) => inSub(n.channel_id));
  const subEdges = data.edges.filter((e) => inSub(e.a) && inSub(e.b));
  const communities =
    subNodes.length > 0 ? detectCommunities({ nodes: subNodes, edges: subEdges }) : new Map();

  const byCommunity = new Map<number, string[]>();
  for (const n of subNodes) {
    const c = communities.get(n.channel_id) ?? 0;
    if (!byCommunity.has(c)) byCommunity.set(c, []);
    byCommunity.get(c)!.push(n.channel_id);
  }
  const commList = [...byCommunity.entries()].sort((a, b) => b[1].length - a[1].length);

  const totalSize = subNodes.length || 1;
  const MIN_SECTOR = (2 * Math.PI) / 24; // 15° 下限,避免單節點社群塌成一點
  // 先算出每個社群需要的扇區大小,超過 2π 時等比縮回
  const rawSectors = commList.map(([, members]) => {
    const proportional = (members.length / totalSize) * 2 * Math.PI;
    return Math.max(proportional, MIN_SECTOR);
  });
  const totalRaw = rawSectors.reduce((s, v) => s + v, 0);
  const scale = totalRaw > 2 * Math.PI ? (2 * Math.PI) / totalRaw : 1;

  const angleById = new Map<string, number>();
  let cursor = 0;
  for (let i = 0; i < commList.length; i++) {
    const [, members] = commList[i];
    const sector = rawSectors[i] * scale;
    // 扇區內兩端各留 5% 邊,避免緊鄰扇區的節點角度重疊
    const usable = sector * 0.9;
    const startPad = sector * 0.05;
    members.forEach((id, j) => {
      const t = members.length === 1 ? 0.5 : j / (members.length - 1);
      angleById.set(id, cursor + startPad + usable * t);
    });
    cursor += sector;
  }
  return angleById;
}

/** ego 模式 rings 佈局:d3-force 分環放射,回傳每個節點的座標(依 data.nodes 順序) */
function computeEgoRingsPositions(
  data: NetworkGraphData,
  rings: Map<string, number>,
  halfWidthById: Map<string, number>,
  metrics: { halfWidth: number }[],
  tuning: LayoutTuning,
): { x: number; y: number }[] {
  const nodeIds = data.nodes.map((n) => n.channel_id);
  const ringRadii = computeRingRadii(rings, halfWidthById);

  const simNodes: SimNode[] = data.nodes.map((n) => ({ id: n.channel_id }));
  const nodeIdSet = new Set(nodeIds);
  const simLinks = data.edges
    .filter((e) => nodeIdSet.has(e.a) && nodeIdSet.has(e.b))
    .map((e) => ({ source: e.a, target: e.b }));

  // hop1+hop2 依 Louvain 社群分角度扇區,同社群靠在同扇區,不同社群拉開角度。
  // 這樣 hop2 就不會全擠一起,自然依邊密度分成幾個明顯次群。
  const angleById = computeCommunitySectorAngles(data, rings);
  for (const id of nodeIds) {
    if (rings.get(id) === EGO_OUTER_RING) angleById.set(id, hashAngle(id));
  }

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

  const outerRadialStrength = tuning.radialStrength * (0.5 / 0.9); // 保持外圍相對比例
  const sim = forceSimulation(simNodes)
    .force(
      "link",
      forceLink(simLinks)
        .id((d) => (d as SimNode).id)
        .strength(tuning.linkStrength),
    )
    .force("charge", forceManyBody().strength(tuning.chargeStrength))
    .force(
      "collide",
      forceCollide(
        (_d, i) => Math.max(metrics[i].halfWidth, HEX_RADIUS) + tuning.collidePadding,
      ),
    )
    .force(
      "radial",
      forceRadial(
        (d) => ringRadii[rings.get((d as SimNode).id)!],
        0,
        0,
      ).strength((d) =>
        rings.get((d as SimNode).id)! >= EGO_OUTER_RING
          ? outerRadialStrength
          : tuning.radialStrength,
      ),
    )
    .stop();

  const ticks = Math.ceil(Math.log(sim.alphaMin()) / Math.log(1 - sim.alphaDecay()));
  sim.tick(ticks);

  // 硬性徑向分帶:sim 決定角度,再依環別把 hop1/hop2/hop3 壓回上限、下環推出下限,
  // 確保 hop1(綠)<  hop2(藍)< hop3(紫)< outer(灰)四環嚴格分離,且各環都在對應圓周內。
  const BAND_GAP = tuning.bandGap;
  const applyRing = (
    ring: number,
    floor: number,
    cap: number,
  ): number => {
    let maxR = 0;
    for (const sn of simNodes) {
      if (rings.get(sn.id) !== ring) continue;
      const r = Math.hypot(sn.x ?? 0, sn.y ?? 0);
      if (r < floor && r > 0.01) {
        const s = floor / r;
        sn.x = (sn.x ?? 0) * s;
        sn.y = (sn.y ?? 0) * s;
      }
      const r2 = Math.hypot(sn.x ?? 0, sn.y ?? 0);
      if (r2 > cap && r2 > 0.01) {
        const s = cap / r2;
        sn.x = (sn.x ?? 0) * s;
        sn.y = (sn.y ?? 0) * s;
      }
      const newR = Math.hypot(sn.x ?? 0, sn.y ?? 0);
      if (newR > maxR) maxR = newR;
    }
    return maxR;
  };
  const hop1Cap = ringRadii[1] * tuning.hop1CapMultiplier;
  const maxHop1 = applyRing(1, 0, hop1Cap);
  const hop2Cap = ringRadii[2] * tuning.hop2CapMultiplier;
  const maxHop2 = applyRing(2, maxHop1 + BAND_GAP, hop2Cap);
  const hop3Cap = Math.max(
    ringRadii[3] * tuning.hop3CapMultiplier,
    maxHop2 + BAND_GAP,
  );
  const maxHop3 = applyRing(3, maxHop2 + BAND_GAP, hop3Cap);
  const outerCap = Math.max(
    ringRadii[4] * tuning.outerCapMultiplier,
    maxHop3 + BAND_GAP,
  );
  applyRing(EGO_OUTER_RING, maxHop3 + BAND_GAP, outerCap);

  return simNodes.map((sn) => ({ x: sn.x ?? 0, y: sn.y ?? 0 }));
}

/**
 * ego 模式 force 佈局:直接沿用全圖 FA2 結果(linLog + strongGravity + scalingRatio,
 * 對節點多、邊密的社群才處理得動;純 d3-force 弱 charge/gravity 對大圖會全部糊一坨)。
 * computeLayout 之後會 translate 讓圓心位於 (0,0),所以這裡不用自己居中。
 * rings 依 BFS 分色仍有效(hop1/2/3 顏色不變),tuning 面板參數在這模式不生效。
 */
function computeEgoForcePositions(
  data: NetworkGraphData,
  useCache: boolean,
): { x: number; y: number }[] {
  const basis = getGlobalBasis(data, useCache);
  return basis.positions.map((p) => ({ x: p.x, y: p.y }));
}

/**
 * ego 模式 sunburst 佈局:radial tree。
 * - hop1 均分 2π
 * - hop2 挑一個 hop1 parent(第一個找到的),放在 parent 的角度扇區內
 * - hop3 同理挑 hop2 parent
 * - 外圍(ring 4)用 hashAngle,放在最外圈
 *
 * 節點有多個 parent 時武斷選第一個(親子語意的固有限制)。
 */
function computeEgoSunburstPositions(
  data: NetworkGraphData,
  rings: Map<string, number>,
  halfWidthById: Map<string, number>,
): { x: number; y: number }[] {
  const nodeIds = data.nodes.map((n) => n.channel_id);
  const adjacency = buildAdjacency(data);
  const ringRadii = computeRingRadii(rings, halfWidthById);

  const hop1Ids = nodeIds.filter((id) => rings.get(id) === 1);
  const hop2Ids = nodeIds.filter((id) => rings.get(id) === 2);
  const hop3Ids = nodeIds.filter((id) => rings.get(id) === 3);

  // hop1:2π 平均分配
  const angleById = new Map<string, number>();
  const hop1Wedge = (2 * Math.PI) / Math.max(hop1Ids.length, 1);
  hop1Ids.forEach((id, i) => {
    angleById.set(id, i * hop1Wedge);
  });

  // hop2:挑一個 hop1 parent,依 parent 分組後在 parent 的扇區內均分
  const hop2ByParent = new Map<string, string[]>();
  const hop2Orphan: string[] = [];
  for (const id of hop2Ids) {
    const parent = [...(adjacency.get(id) ?? [])].find((p) => rings.get(p) === 1);
    if (parent) {
      if (!hop2ByParent.has(parent)) hop2ByParent.set(parent, []);
      hop2ByParent.get(parent)!.push(id);
    } else {
      hop2Orphan.push(id);
    }
  }
  // 每個 hop2 分到自己的角寬(等於 hop1 扇區的 90% / 兄弟姊妹數),供 hop3 再細分用
  const hop2OwnWedge = new Map<string, number>();
  for (const [, children] of hop2ByParent) {
    const per = (hop1Wedge * 0.9) / children.length;
    for (const childId of children) hop2OwnWedge.set(childId, per);
  }
  for (const [parent, children] of hop2ByParent) {
    const parentAngle = angleById.get(parent)!;
    const subWedge = hop1Wedge * 0.9;
    const startAngle = parentAngle - subWedge / 2;
    children.forEach((childId, i) => {
      const t = children.length === 1 ? 0.5 : i / (children.length - 1);
      angleById.set(childId, startAngle + subWedge * t);
    });
  }
  hop2Orphan.forEach((id) => angleById.set(id, hashAngle(id)));

  // hop3:挑一個 hop2 parent,依 parent 自己的角寬再細分
  const hop3ByParent = new Map<string, string[]>();
  const hop3Orphan: string[] = [];
  for (const id of hop3Ids) {
    const parent = [...(adjacency.get(id) ?? [])].find((p) => rings.get(p) === 2);
    if (parent && angleById.has(parent)) {
      if (!hop3ByParent.has(parent)) hop3ByParent.set(parent, []);
      hop3ByParent.get(parent)!.push(id);
    } else {
      hop3Orphan.push(id);
    }
  }
  for (const [parent, children] of hop3ByParent) {
    const parentAngle = angleById.get(parent)!;
    const parentWedge = hop2OwnWedge.get(parent) ?? hop1Wedge * 0.1;
    const subWedge = parentWedge * 0.9;
    const startAngle = parentAngle - subWedge / 2;
    children.forEach((childId, i) => {
      const t = children.length === 1 ? 0.5 : i / (children.length - 1);
      angleById.set(childId, startAngle + subWedge * t);
    });
  }
  hop3Orphan.forEach((id) => angleById.set(id, hashAngle(id)));

  return data.nodes.map((n) => {
    const id = n.channel_id;
    const ring = rings.get(id) ?? EGO_OUTER_RING;
    if (ring === 0) return { x: 0, y: 0 };
    const angle =
      ring === EGO_OUTER_RING
        ? hashAngle(id)
        : angleById.get(id) ?? hashAngle(id);
    return {
      x: Math.cos(angle) * ringRadii[ring],
      y: Math.sin(angle) * ringRadii[ring],
    };
  });
}

/** ego 模式:依 mode 分派到對應佈局函式 */
function computeEgoPositions(
  data: NetworkGraphData,
  rings: Map<string, number>,
  halfWidthById: Map<string, number>,
  metrics: { halfWidth: number }[],
  tuning: LayoutTuning,
  mode: EgoLayoutMode,
  useCache: boolean,
): { x: number; y: number }[] {
  if (mode === "force") {
    return computeEgoForcePositions(data, useCache);
  }
  if (mode === "sunburst") {
    return computeEgoSunburstPositions(data, rings, halfWidthById);
  }
  return computeEgoRingsPositions(data, rings, halfWidthById, metrics, tuning);
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
  tuning: LayoutTuning = DEFAULT_TUNING,
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
    ? computeEgoPositions(data, rings!, halfWidthById, metrics, tuning, ego!.mode ?? "rings", !measure)
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
  // 非 ego:全部進 base(灰);ego:依「較外環」分 baseHop1/baseHop2/baseHop3(綠/藍/紫),外圍相關進 dim。
  let bakedEdges: BakedEdges | null = null;
  if (typeof Path2D !== "undefined") {
    const base = new Map<number, Path2D>();
    const baseHop1 = rings ? new Map<number, Path2D>() : null;
    const baseHop2 = rings ? new Map<number, Path2D>() : null;
    const baseHop3 = rings ? new Map<number, Path2D>() : null;
    const dim = rings ? new Map<number, Path2D>() : null;
    for (const le of edges) {
      let bucket: Map<number, Path2D>;
      if (rings) {
        if (le.egoDim > 0) {
          bucket = dim!;
        } else {
          // 兩端都在 rings 0-3:取較外環決定顏色(hop1=綠、hop2=藍、hop3=紫)
          const ra = rings.get(le.edge.a) ?? 0;
          const rb = rings.get(le.edge.b) ?? 0;
          const outer = Math.max(ra, rb);
          if (outer >= 3) bucket = baseHop3!;
          else if (outer >= 2) bucket = baseHop2!;
          else bucket = baseHop1!;
        }
      } else {
        bucket = base;
      }
      let p = bucket.get(le.widthBucket);
      if (!p) {
        p = new Path2D();
        bucket.set(le.widthBucket, p);
      }
      p.moveTo(le.source.x, le.source.y);
      p.quadraticCurveTo(le.controlX, le.controlY, le.target.x, le.target.y);
    }
    bakedEdges = { base, baseHop1, baseHop2, baseHop3, dim };
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
