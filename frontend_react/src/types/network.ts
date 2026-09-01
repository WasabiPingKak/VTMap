/** VTuber 關係網路 API 型別 */

export interface NetworkNode {
  channel_id: string;
  title: string | null;
  handle: string | null;
  thumbnail: string | null;
  in_vtmap: boolean;
  /** YouTube 訂閱數;null = 尚未取得或頻道隱藏訂閱數 */
  subscriber_count: number | null;
  /** 是否曾被當成 host 掃過(有觀察紀錄以他為 host)。
   *  false 代表這個節點只是別人直播裡出現過,我們還沒去讀他自己的直播,連線數會偏少。 */
  scanned: boolean;
}

export interface EdgeEvidence {
  video_id: string;
  video_title: string | null;
  video_published_at: string | null;
  moderator_channel_id: string;
}

export interface NetworkEdge {
  a: string;
  b: string;
  evidence_count: number;
  last_seen_video_at: string | null;
  evidence: EdgeEvidence[];
}

export interface NetworkGraphData {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
}

/** 「最新加入」面板用的頻道摘要:比 NetworkNode 少 in_vtmap、多一個 created_at */
export interface RecentNode {
  channel_id: string;
  title: string | null;
  handle: string | null;
  thumbnail: string | null;
  subscriber_count: number | null;
  /** channels.created_at 的 ISO 字串;前端算相對時間 */
  created_at: string | null;
  scanned: boolean;
}

/** 力導向 layout 計算後的節點位置與標籤度量 */
export interface LayoutNode {
  node: NetworkNode;
  x: number;
  y: number;
  /** 換行後的標籤(永遠顯示在節點下方) */
  labelLines: string[];
  /** 佔用矩形半寬(layout 已保證互不重疊) */
  labelHalfWidth: number;
  /** 節點中心以下的佔用高度 */
  labelBottomHeight: number;
}

export interface LayoutEdge {
  edge: NetworkEdge;
  source: LayoutNode;
  target: LayoutNode;
  /** 預算的貝茲控制點(source/target 固定後不變) */
  controlX: number;
  controlY: number;
  /** 邊長度平方,配合縮放做「螢幕長度 &lt; N px」裁剪 */
  lenSq: number;
  /** AABB,配合視野裁剪 */
  boxMinX: number;
  boxMinY: number;
  boxMaxX: number;
  boxMaxY: number;
  /** 線寬桶(依 evidence_count 預算,配合 stroke groups key 用) */
  widthBucket: number;
  /** ego 模式端點淡化狀態:0=兩端都亮、1=一端在外圍、2=兩端都在外圍(直接跳過) */
  egoDim: 0 | 1 | 2;
}

/** 空間網格:hitTest 用,把節點依座標分桶,查詢時只掃 3×3 個桶 */
export interface HitGrid {
  cellSize: number;
  /** key = 打包後的 (cx, cy);value = 該桶的節點在 nodes 陣列的索引 */
  cells: Map<number, number[]>;
}

export interface GraphLayout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  /** channel_id → LayoutNode */
  byId: Map<string, LayoutNode>;
  /** channel_id → 相鄰節點 id 集合 */
  neighbors: Map<string, Set<string>>;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** ego 模式的圓心;null = 一般全圖模式 */
  egoCenterId: string | null;
  /** ego 模式的分環結果(0=圓心、1=直接、2=間接、3=外圍);一般模式為 null */
  rings: Map<string, number> | null;
  /** Louvain 社群偵測結果:channel_id → 社群編號(依社群大小排序) */
  communities: Map<string, number> | null;
  /** hitTest 的空間索引 */
  hitGrid: HitGrid;
  /**
   * 預烘的邊 Path2D,依線寬桶分組。渲染時單一 stroke 一次畫完,
   * 取代 per-frame iterate 上萬邊 + 每邊 Path2D group insert。
   * Path2D 不可用時(測試環境)為 null,渲染 fallback 走 frame 迴圈。
   */
  bakedEdges: BakedEdges | null;
  /** channel_id → 相連的 LayoutEdge 列表(hover/focus highlight overlay 用,避免掃全表) */
  edgesByNode: Map<string, LayoutEdge[]>;
}

/**
 * 邊分組:
 * - base:非 ego 模式全部邊(灰色 EDGE_COLOR at EDGE_ALPHA);ego 模式為空(全走 hop 分組)。
 * - baseHop1:ego 模式,較外環 = 1 的邊(中心↔hop1、hop1↔hop1),塗 NEIGHBOR_COLOR。
 * - baseHop2:ego 模式,較外環 = 2 的邊(hop1↔hop2、hop2↔hop2),塗 HOP2_COLOR。
 * - baseHop3:ego 模式,較外環 = 3 的邊(hop2↔hop3、hop3↔hop3),塗 HOP3_COLOR。
 * - dim:ego 模式 egoDim > 0(至少一端在外圍 ring 4)的邊,alpha 固定 EDGE_DIM_ALPHA。
 * 各組獨立分線寬桶,避免不同 alpha/顏色混合在一起。
 */
export interface BakedEdges {
  base: Map<number, Path2D>;
  baseHop1: Map<number, Path2D> | null;
  baseHop2: Map<number, Path2D> | null;
  baseHop3: Map<number, Path2D> | null;
  dim: Map<number, Path2D> | null;
}
