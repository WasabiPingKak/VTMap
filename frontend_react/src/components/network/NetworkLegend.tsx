/**
 * 畫布角落的顏色圖例:節點外框顏色的意義。
 */

import {
  DISCOVERED_COLOR,
  FOCUSED_COLOR,
  IN_VTMAP_COLOR,
  NEIGHBOR_COLOR,
} from "./colors";

const ITEMS: { color: string; label: string }[] = [
  { color: IN_VTMAP_COLOR, label: "VTMap 收錄頻道" },
  { color: DISCOVERED_COLOR, label: "尚未收錄" },
  { color: FOCUSED_COLOR, label: "目前選取" },
  { color: NEIGHBOR_COLOR, label: "選取頻道的關係人" },
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
