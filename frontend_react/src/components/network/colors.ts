/**
 * 關係網路畫布的深色主題色彩系統(設計語彙參考 VTaxon 分類樹)。
 */

export const BG_COLOR = "#080d15";
export const BG_CENTER = "#0d1526";

// 節點外框色 = 與「參考點」(目前選取,無選取時為圓心)的關係距離:
// 金=參考點本人、綠=隔一層、藍=隔兩層、紫=隔三層、灰=更遠或無參考點
export const FOCUSED_COLOR = "#D4A017";
export const FOCUSED_GLOW = "rgba(212,160,23,0.8)";
export const NEIGHBOR_COLOR = "#22c55e";
export const NEIGHBOR_GLOW = "rgba(34,197,94,0.7)";
export const HOP2_COLOR = "#38bdf8";
export const HOP2_GLOW = "rgba(56,189,248,0.6)";
export const HOP3_COLOR = "#7e22ce";
export const HOP3_GLOW = "rgba(126,34,206,0.5)";
export const FAR_COLOR = "#64748b";
export const FAR_GLOW = "rgba(100,116,139,0.5)";

export const EDGE_COLOR = "rgba(148,163,184,0.9)";
export const EDGE_ALPHA = 0.1;
export const EDGE_HIGHLIGHT_ALPHA = 0.75;
export const EDGE_DIM_ALPHA = 0.05;
/** ego 模式:hop-1/hop-2 邊的 alpha,比一般 base 邊(0.1)高、比 hover/focus 高亮(0.75)低,
 *  用來讓分層結構本身就看得見,不用等 hover 才浮現 */
export const EDGE_HOP_ALPHA = 0.45;
// ego 模式邊色比節點色更暗一階(green-700 / sky-700 / violet-700),避免叢集內線與點同色糊成一團
export const HOP1_EDGE_COLOR = "#15803d";
export const HOP2_EDGE_COLOR = "#0369a1";
export const HOP3_EDGE_COLOR = "#581c87";

export const LABEL_COLOR = "rgba(255,255,255,0.85)";
export const LABEL_DIM = "rgba(255,255,255,0.35)";

export const NODE_DIM_ALPHA = 0.25;
