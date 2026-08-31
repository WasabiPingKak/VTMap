/** VTuber 關係網路 API 型別 */

export interface NetworkNode {
  channel_id: string;
  title: string | null;
  handle: string | null;
  thumbnail: string | null;
  in_vtmap: boolean;
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
}
