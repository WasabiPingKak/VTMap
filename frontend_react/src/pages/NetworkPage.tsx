/**
 * VTuber 關係網路頁:全螢幕沉浸式網狀圖(參考 VTaxon 首頁模式)。
 * 所有 UI 都是懸浮在圖上的元件,唯一的離開路徑是左上角「回 VTMap」按鈕。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { FaClipboardList, FaInfoCircle } from "react-icons/fa";
import { ArrowLeft, LocateFixed } from "lucide-react";
import NetworkGraph, { type NetworkGraphHandle } from "@/components/network/NetworkGraph";
import DetailPanel from "@/components/network/DetailPanel";
import NetworkToolbar from "@/components/network/NetworkToolbar";
import NetworkLegend from "@/components/network/NetworkLegend";
import RecentNodesPanel from "@/components/network/RecentNodesPanel";
import TuningPanel from "@/components/network/TuningPanel";
import { DEFAULT_TUNING, type LayoutTuning } from "@/components/network/layout";
import { useNetworkGraph } from "@/hooks/useNetworkGraph";
import { useMyChannelId } from "@/hooks/useMyChannelId";

const PANEL_INSET = 340;
const TUNING_STORAGE_KEY = "vtmap.network.tuning.v1";
const TUNING_DEBOUNCE_MS = 300;

function loadStoredTuning(): LayoutTuning {
  if (typeof window === "undefined") return DEFAULT_TUNING;
  try {
    const raw = window.localStorage.getItem(TUNING_STORAGE_KEY);
    if (!raw) return DEFAULT_TUNING;
    const parsed = JSON.parse(raw) as Partial<LayoutTuning>;
    // 缺欄位用預設補齊,防止舊版 storage 少欄位
    return { ...DEFAULT_TUNING, ...parsed };
  } catch {
    return DEFAULT_TUNING;
  }
}

export default function NetworkPage() {
  const { data, isLoading, isError } = useNetworkGraph();
  const { data: me } = useMyChannelId();
  const [searchParams, setSearchParams] = useSearchParams();
  const graphRef = useRef<NetworkGraphHandle | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [showRecent, setShowRecent] = useState(false);
  const [showTuning, setShowTuning] = useState(false);
  // 兩份 tuning:編輯用即時更新面板 UI,committed 延遲 300ms 才觸發 re-layout
  const [tuning, setTuning] = useState<LayoutTuning>(loadStoredTuning);
  const [committedTuning, setCommittedTuning] = useState<LayoutTuning>(tuning);
  useEffect(() => {
    const t = window.setTimeout(() => setCommittedTuning(tuning), TUNING_DEBOUNCE_MS);
    try {
      window.localStorage.setItem(TUNING_STORAGE_KEY, JSON.stringify(tuning));
    } catch {
      // localStorage 滿了或被 disable,忽略
    }
    return () => window.clearTimeout(t);
  }, [tuning]);

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

  // 定位:若有選取節點,同時把它設為圓心(layout 重算後 ego 效果自動 fit);
  //       否則優先圓心 > 自己的頻道 > 顯示全圖。
  const handleLocate = useCallback(() => {
    if (focusedId && focusedId !== centerId) {
      setCenter(focusedId);
      return;
    }
    const candidates = [centerId, focusedId, me?.channelId];
    for (const id of candidates) {
      if (id && graphRef.current?.panToNode(id)) return;
    }
    graphRef.current?.fitAll();
  }, [centerId, focusedId, me?.channelId, setCenter]);

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
            tuning={committedTuning}
          />
          <NetworkToolbar
            data={data}
            onSelect={setFocus}
            onZoomIn={() => graphRef.current?.zoomIn()}
            onZoomOut={() => graphRef.current?.zoomOut()}
            onFitAll={() => graphRef.current?.fitAll()}
            onOpenRecent={() => setShowRecent(true)}
            onToggleTuning={() => setShowTuning((v) => !v)}
          />
          {showTuning && (
            <TuningPanel
              tuning={tuning}
              onChange={setTuning}
              onClose={() => setShowTuning(false)}
            />
          )}
          <NetworkLegend />
          {/* 上方中央:圓心 pill + 定位按鈕(從左工具列搬過來,語意上跟圓心/選取狀態綁在一起)*/}
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center gap-2">
            {centerNode && (
              <div className="flex items-center gap-2 rounded-full bg-amber-500/15 border border-amber-500/60 px-3 py-1 text-sm text-amber-300">
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
            <button
              onClick={handleLocate}
              aria-label="定位"
              title="定位:有選取則設為圓心,否則到現有圓心或自己的頻道"
              className="p-2 rounded-lg bg-slate-950/80 backdrop-blur border border-slate-800 text-slate-300 hover:text-white hover:bg-slate-800"
            >
              <LocateFixed size={16} />
            </button>
          </div>
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
          {showRecent && (
            <RecentNodesPanel
              onFocus={(id) => {
                setFocus(id);
                setShowRecent(false);
              }}
              onClose={() => setShowRecent(false)}
            />
          )}
        </>
      )}

      {/* 回主站(唯一離開路徑,左上角);最新加入面板打開時,按鈕搬到面板 header 內以避免遮擋 */}
      {!showRecent && (
        <Link
          to="/live-redirect"
          className="absolute top-3 left-3 z-20 flex items-center gap-2 rounded-lg bg-slate-950/80 backdrop-blur border border-slate-800 px-3 py-2 text-sm text-slate-100 hover:bg-slate-800"
        >
          <ArrowLeft size={15} />
          回 VTMap
        </Link>
      )}

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
