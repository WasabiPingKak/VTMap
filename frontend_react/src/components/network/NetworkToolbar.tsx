/**
 * 畫布左上角的工具列:搜尋頻道、縮放、顯示全圖。
 */

import { useMemo, useState } from "react";
import { Clock, Maximize2, Minus, Plus, Search } from "lucide-react";
import type { NetworkGraphData, NetworkNode } from "@/types/network";
import { channelDisplayName } from "./displayName";

interface NetworkToolbarProps {
  data: NetworkGraphData;
  onSelect: (channelId: string) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitAll: () => void;
  /** 展開「最新加入」面板 */
  onOpenRecent: () => void;
}

export default function NetworkToolbar({
  data,
  onSelect,
  onZoomIn,
  onZoomOut,
  onFitAll,
  onOpenRecent,
}: NetworkToolbarProps) {
  const [query, setQuery] = useState("");

  const matches: NetworkNode[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return data.nodes
      .filter(
        (n) =>
          (n.title ?? "").toLowerCase().includes(q) ||
          (n.handle ?? "").toLowerCase().includes(q) ||
          n.channel_id.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [query, data]);

  return (
    <div className="absolute top-16 left-3 z-10 flex flex-col gap-2 w-60">
      <div className="relative">
        <div className="flex items-center gap-2 rounded-lg bg-slate-950/80 backdrop-blur border border-slate-800 px-3 py-2">
          <Search size={14} className="text-slate-400 shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜尋頻道"
            className="bg-transparent outline-none text-sm text-slate-100 placeholder:text-slate-500 w-full"
          />
        </div>
        {matches.length > 0 && (
          <ul className="absolute z-20 mt-1 w-full rounded-lg bg-slate-950/95 border border-slate-800 overflow-hidden">
            {matches.map((n) => (
              <li key={n.channel_id}>
                <button
                  className="w-full text-left px-3 py-2 text-sm text-slate-200 hover:bg-slate-800 truncate"
                  onClick={() => {
                    onSelect(n.channel_id);
                    setQuery("");
                  }}
                >
                  {channelDisplayName(n)}
                  {n.title && n.handle && (
                    <span className="text-slate-500 ml-1">{n.handle}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex gap-1">
        {[
          { icon: <Plus size={16} />, action: onZoomIn, label: "放大" },
          { icon: <Minus size={16} />, action: onZoomOut, label: "縮小" },
          { icon: <Maximize2 size={16} />, action: onFitAll, label: "顯示全圖" },
          { icon: <Clock size={16} />, action: onOpenRecent, label: "最新加入" },
        ].map(({ icon, action, label }) => (
          <button
            key={label}
            onClick={action}
            aria-label={label}
            title={label}
            className="p-2 rounded-lg bg-slate-950/80 backdrop-blur border border-slate-800 text-slate-300 hover:text-white hover:bg-slate-800"
          >
            {icon}
          </button>
        ))}
      </div>
    </div>
  );
}
