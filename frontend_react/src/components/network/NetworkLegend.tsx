/**
 * 畫布角落的顏色圖例:節點外框顏色的意義。
 */

import {
  FAR_COLOR,
  FOCUSED_COLOR,
  HOP2_COLOR,
  HOP3_COLOR,
  NEIGHBOR_COLOR,
} from "./colors";

const ITEMS: { color: string; label: string }[] = [
  { color: FOCUSED_COLOR, label: "目前選取" },
  { color: NEIGHBOR_COLOR, label: "直接關係" },
  { color: HOP2_COLOR, label: "隔兩層關係" },
  { color: HOP3_COLOR, label: "隔三層關係" },
  { color: FAR_COLOR, label: "更遠或未選取" },
];

function HexSwatch({ color }: { color: string }) {
  // 與節點相同的六角形(尖角朝上)
  const points = Array.from({ length: 6 }, (_, i) => {
    const angle = (Math.PI / 3) * i - Math.PI / 2;
    return `${8 + 7 * Math.cos(angle)},${8 + 7 * Math.sin(angle)}`;
  }).join(" ");
  return (
    <svg width="16" height="16" className="shrink-0">
      <polygon points={points} fill="none" stroke={color} strokeWidth="2" />
    </svg>
  );
}

export default function NetworkLegend() {
  return (
    <div className="absolute bottom-3 left-3 z-10 rounded-lg bg-slate-950/80 backdrop-blur border border-slate-800 px-3 py-2 space-y-1">
      {ITEMS.map(({ color, label }) => (
        <div key={label} className="flex items-center gap-2 text-xs text-slate-300">
          <HexSwatch color={color} />
          {label}
        </div>
      ))}
    </div>
  );
}
