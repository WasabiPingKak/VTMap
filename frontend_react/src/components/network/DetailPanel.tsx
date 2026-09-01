/**
 * 聚焦頻道的詳情側板:頻道資訊、關係清單與證據影片。
 */

import { useMemo } from "react";
import { Crosshair, X } from "lucide-react";
import type { NetworkEdge, NetworkGraphData, NetworkNode } from "@/types/network";
import { channelDisplayName, channelInitial } from "./displayName";
import { formatSubscribers } from "./formatters";

interface DetailPanelProps {
  data: NetworkGraphData;
  focusedId: string;
  /** 目前的 ego 圓心(null = 一般全圖) */
  centerId: string | null;
  onClose: () => void;
  onFocusChange: (channelId: string) => void;
  onSetCenter: (channelId: string | null) => void;
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}

export default function DetailPanel({
  data,
  focusedId,
  centerId,
  onClose,
  onFocusChange,
  onSetCenter,
}: DetailPanelProps) {
  // 建 channel_id → node 索引一次,避免每筆關係都對 data.nodes 掃全表
  const nodeById = useMemo(() => {
    const m = new Map<string, NetworkNode>();
    for (const n of data.nodes) m.set(n.channel_id, n);
    return m;
  }, [data]);

  // relations 只在 data / focusedId 變時重算(排序也一併記憶)
  const relations = useMemo(() => {
    const out: { other: NetworkNode; edge: NetworkEdge }[] = [];
    for (const edge of data.edges) {
      const otherId = edge.a === focusedId ? edge.b : edge.b === focusedId ? edge.a : null;
      if (!otherId) continue;
      const other = nodeById.get(otherId);
      if (other) out.push({ other, edge });
    }
    out.sort((x, y) => y.edge.evidence_count - x.edge.evidence_count);
    return out;
  }, [data, focusedId, nodeById]);

  const channel = nodeById.get(focusedId);
  if (!channel) return null;

  const isCenter = centerId === focusedId;

  return (
    <aside className="absolute top-0 right-0 h-full w-full sm:w-[340px] bg-slate-950/90 backdrop-blur border-l border-slate-800 text-slate-100 flex flex-col z-10">
      {/* 頻道資訊 */}
      <div className="p-4 border-b border-slate-800 flex items-start gap-3">
        {channel.thumbnail ? (
          <img
            src={channel.thumbnail}
            alt=""
            className="w-12 h-12 rounded-full border border-slate-700"
          />
        ) : (
          <div className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center text-lg">
            {channelInitial(channel)}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="font-bold truncate">{channelDisplayName(channel)}</div>
          <div className="text-xs text-slate-400 mt-0.5">
            {channel.title && channel.handle && <span className="mr-2">{channel.handle}</span>}
            {formatSubscribers(channel.subscriber_count)}
          </div>
          <a
            href={`https://www.youtube.com/channel/${channel.channel_id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-sky-400 hover:underline"
          >
            前往 YouTube 頻道
          </a>
          <button
            onClick={() => onSetCenter(isCenter ? null : focusedId)}
            className={`mt-2 flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs border ${
              isCenter
                ? "border-amber-500 text-amber-400 hover:bg-amber-500/10"
                : "border-slate-600 text-slate-200 hover:bg-slate-800"
            }`}
          >
            <Crosshair size={13} />
            {isCenter ? "取消圓心檢視" : "指定它變成圓心"}
          </button>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-slate-800"
          aria-label="關閉"
        >
          <X size={18} />
        </button>
      </div>

      {/* 等待掃描提示:讓看到「連線這麼少?」的路人知道原因是資料還沒讀完 */}
      {!channel.scanned && (
        <div className="mx-4 mt-3 rounded-md border border-amber-800/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
          <div className="font-medium mb-0.5">等待掃描</div>
          <div className="text-amber-200/80">
            這個頻道自己的直播還沒讀,關係之後會補上
          </div>
        </div>
      )}

      {/* 關係清單 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div className="text-sm text-slate-400">
          管理員關係 {relations.length} 筆
        </div>
        {relations.map(({ other, edge }) => (
          <div key={other.channel_id} className="rounded-lg border border-slate-800 bg-slate-900/60">
            <button
              onClick={() => onFocusChange(other.channel_id)}
              className="w-full flex items-center gap-2 p-3 text-left hover:bg-slate-800/60 rounded-t-lg"
            >
              {other.thumbnail ? (
                <img src={other.thumbnail} alt="" className="w-8 h-8 rounded-full" />
              ) : (
                <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-sm">
                  {channelInitial(other)}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="truncate text-sm font-medium">
                  {channelDisplayName(other)}
                </div>
                <div className="text-xs text-slate-500">
                  出現於 {edge.evidence_count} 部直播
                  {edge.last_seen_video_at && `,最近 ${formatDate(edge.last_seen_video_at)}`}
                </div>
              </div>
            </button>
            {edge.evidence.length > 0 && (
              <ul className="px-3 pb-3 space-y-1">
                {edge.evidence.slice(0, 5).map((ev) => (
                  <li key={ev.video_id} className="text-xs truncate">
                    <a
                      href={`https://www.youtube.com/watch?v=${ev.video_id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-slate-400 hover:text-sky-400 hover:underline"
                    >
                      {formatDate(ev.video_published_at)} {ev.video_title || ev.video_id}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}
