/**
 * VTuber 關係網路頁:全螢幕沉浸式網狀圖(參考 VTaxon 首頁模式)。
 * 所有 UI 都是懸浮在圖上的元件,唯一的離開路徑是左上角「回 VTMap」按鈕。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { FaClipboardList, FaInfoCircle } from "react-icons/fa";
import { ArrowLeft } from "lucide-react";
import NetworkGraph, { type NetworkGraphHandle } from "@/components/network/NetworkGraph";
import DetailPanel from "@/components/network/DetailPanel";
import NetworkToolbar from "@/components/network/NetworkToolbar";
import NetworkLegend from "@/components/network/NetworkLegend";
import { useNetworkGraph } from "@/hooks/useNetworkGraph";
import { useMyChannelId } from "@/hooks/useMyChannelId";
import { useLiveRedirectData } from "@/hooks/useLiveRedirectData";

const PANEL_INSET = 340;

export default function NetworkPage() {
  const { data, isLoading, isError } = useNetworkGraph();
  const { data: me, isLoading: meLoading } = useMyChannelId();
  const liveQuery = useLiveRedirectData();
  const [searchParams, setSearchParams] = useSearchParams();
  const graphRef = useRef<NetworkGraphHandle | null>(null);
  const [showInfo, setShowInfo] = useState(false);

  const focusedId = searchParams.get("focus");
  const centerId = searchParams.get("center");

  const setFocus = useCallback(
    (channelId: string | null) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (channelId) next.set("focus", channelId);
          else next.delete("focus");
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const setCenter = useCallback(
    (channelId: string | null) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (channelId) next.set("center", channelId);
          else next.delete("center");
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const centerNode = centerId ? data?.nodes.find((n) => n.channel_id === centerId) : null;

  // 初始節點:進頁時網址沒帶 focus/center 就自動選一個,訪客一進來就有定位好的視角。
  // 優先序:自己的頻道(已登入且在圖上)> 正在直播且在圖上的頻道隨機 > 圖上隨機
  const autoFocused = useRef(false);
  useEffect(() => {
    if (autoFocused.current || !data?.nodes.length) return;
    if (searchParams.get("focus") || searchParams.get("center")) {
      autoFocused.current = true;
      return;
    }
    // 等登入狀態與直播清單就緒(失敗也算就緒,走後備選項)
    if (meLoading || liveQuery.isLoading) return;
    autoFocused.current = true;

    const inGraph = new Set(data.nodes.map((n) => n.channel_id));
    let target: string | null = null;
    if (me?.channelId && inGraph.has(me.channelId)) {
      target = me.channelId;
    }
    if (!target) {
      const liveInGraph = (liveQuery.data?.live ?? [])
        .map((channel) => channel.channel_id)
        .filter((id) => inGraph.has(id));
      if (liveInGraph.length) {
        target = liveInGraph[Math.floor(Math.random() * liveInGraph.length)];
      }
    }
    if (!target) {
      target = data.nodes[Math.floor(Math.random() * data.nodes.length)].channel_id;
    }
    setFocus(target);
  }, [data, me, meLoading, liveQuery.isLoading, liveQuery.data, searchParams, setFocus]);

  // 定位:圓心 > 選取節點 > 自己的頻道(已登入且在圖上)> 顯示全圖
  const handleLocate = useCallback(() => {
    const candidates = [centerId, focusedId, me?.channelId];
    for (const id of candidates) {
      if (id && graphRef.current?.panToNode(id)) return;
    }
    graphRef.current?.fitAll();
  }, [centerId, focusedId, me?.channelId]);

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#080d15]">
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center text-slate-400">
          關係網路載入中…
        </div>
      )}
      {isError && (
        <div className="absolute inset-0 flex items-center justify-center text-red-400">
          資料載入失敗,請稍後再試。
        </div>
      )}
      {data && data.nodes.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-slate-400">
          目前還沒有關係資料。
        </div>
      )}
      {data && data.nodes.length > 0 && (
        <>
          <NetworkGraph
            ref={graphRef}
            data={data}
            focusedId={focusedId}
            egoCenterId={centerId}
            onFocusChange={setFocus}
            panelInset={focusedId ? PANEL_INSET : 0}
          />
          <NetworkToolbar
            data={data}
            onSelect={setFocus}
            onZoomIn={() => graphRef.current?.zoomIn()}
            onZoomOut={() => graphRef.current?.zoomOut()}
            onFitAll={() => graphRef.current?.fitAll()}
            onLocate={handleLocate}
          />
          <NetworkLegend />
          {centerNode && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 rounded-full bg-amber-500/15 border border-amber-500/60 px-3 py-1 text-sm text-amber-300">
              圓心:{centerNode.title || centerNode.handle || centerNode.channel_id}
              <button
                onClick={() => setCenter(null)}
                className="hover:text-amber-100"
                aria-label="取消圓心檢視"
              >
                ✕
              </button>
            </div>
          )}
          {focusedId && (
            <DetailPanel
              data={data}
              focusedId={focusedId}
              centerId={centerId}
              onClose={() => setFocus(null)}
              onFocusChange={setFocus}
              onSetCenter={setCenter}
            />
          )}
        </>
      )}

      {/* 回主站(唯一離開路徑,左上角) */}
      <Link
        to="/live-redirect"
        className="absolute top-3 left-3 z-20 flex items-center gap-2 rounded-lg bg-slate-950/80 backdrop-blur border border-slate-800 px-3 py-2 text-sm text-slate-100 hover:bg-slate-800"
      >
        <ArrowLeft size={15} />
        回 VTMap
      </Link>

      {/* 管理員:資料蒐集佇列(右上) */}
      {me?.isAdmin && (
        <Link
          to="/network/queue"
          className="absolute top-3 right-3 z-10 flex items-center gap-2 rounded-lg bg-slate-950/80 backdrop-blur border border-slate-800 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
        >
          <FaClipboardList className="w-4 h-4" />
          資料蒐集佇列
        </Link>
      )}

      {/* 資料來源說明(右下 ⓘ) */}
      <div className="absolute bottom-3 right-3 z-10 flex flex-col items-end gap-2">
        {showInfo && (
          <div className="max-w-[300px] rounded-lg bg-slate-950/90 backdrop-blur border border-slate-800 px-3 py-2 text-xs text-slate-300 leading-relaxed">
            關係來源:過去直播聊天室中的管理員標記,雙方任一邊給予管理員身份即視為互相認識。
          </div>
        )}
        <button
          onClick={() => setShowInfo((v) => !v)}
          aria-label="資料來源說明"
          className="p-2 rounded-full bg-slate-950/80 backdrop-blur border border-slate-800 text-slate-300 hover:text-white hover:bg-slate-800"
        >
          <FaInfoCircle className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
