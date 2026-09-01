/**
 * 「最新加入」側邊面板:列出圖上最近新增的頻道,每列可點擊聚焦。
 * 目的是讓路人不用點節點也能看到誰是新面孔、誰還在等待掃描,避免看到連線數少誤以為壞掉。
 */

import { X } from "lucide-react";
import { useRecentNodes } from "@/hooks/useRecentNodes";
import { channelDisplayName, channelInitial } from "./displayName";
import { formatRelativeAdded, formatSubscribers } from "./formatters";

interface RecentNodesPanelProps {
  onFocus: (channelId: string) => void;
  onClose: () => void;
}

export default function RecentNodesPanel({ onFocus, onClose }: RecentNodesPanelProps) {
  const { data, isLoading, isError } = useRecentNodes();

  return (
    <aside className="absolute top-0 left-0 h-full w-full sm:w-[320px] bg-slate-950/90 backdrop-blur border-r border-slate-800 text-slate-100 flex flex-col z-20">
      <div className="p-4 border-b border-slate-800 flex items-center justify-between">
        <div>
          <div className="font-bold text-sm">最新加入</div>
          <div className="text-xs text-slate-400 mt-0.5">圖上最近出現的頻道</div>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-slate-800"
          aria-label="關閉"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <div className="p-4 text-sm text-slate-400">載入中…</div>
        )}
        {isError && (
          <div className="p-4 text-sm text-red-400">載入失敗,請稍後再試。</div>
        )}
        {data && data.length === 0 && (
          <div className="p-4 text-sm text-slate-400">目前沒有新加入的頻道。</div>
        )}
        {data && data.length > 0 && (
          <ul className="divide-y divide-slate-800">
            {data.map((node) => (
              <li key={node.channel_id}>
                <button
                  onClick={() => onFocus(node.channel_id)}
                  className="w-full text-left flex items-start gap-3 p-3 hover:bg-slate-800/60"
                >
                  {node.thumbnail ? (
                    <img
                      src={node.thumbnail}
                      alt=""
                      className="w-10 h-10 rounded-full border border-slate-700 shrink-0"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center text-base shrink-0">
                      {channelInitial(node)}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{channelDisplayName(node)}</div>
                    <div className="text-xs text-slate-400 mt-0.5 flex items-center gap-1.5 flex-wrap">
                      <span>{formatRelativeAdded(node.created_at)}</span>
                      <span className="text-slate-600">·</span>
                      {node.scanned ? (
                        <span className="text-emerald-400">已掃描</span>
                      ) : (
                        <span className="rounded-full bg-amber-950/60 border border-amber-800/60 px-1.5 py-0.5 text-[10px] text-amber-300 leading-none">
                          等待掃描
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5 truncate">
                      {formatSubscribers(node.subscriber_count)}
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
