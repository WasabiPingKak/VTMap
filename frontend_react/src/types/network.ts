/** VTuber 關係網路 API 型別 */

export interface NetworkNode {
  channel_id: string;
  title: string | null;
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

/** 力導向 layout 計算後的節點位置 */
export interface LayoutNode {
  node: NetworkNode;
  x: number;
  y: number;
}

export interface LayoutEdge {
  edge: NetworkEdge;
  source: LayoutNode;
  target: LayoutNode;
}

export interface GraphLayout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  /** channel_id → LayoutNode */
  byId: Map<string, LayoutNode>;
  /** channel_id → 相鄰節點 id 集合 */
  neighbors: Map<string, Set<string>>;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}
