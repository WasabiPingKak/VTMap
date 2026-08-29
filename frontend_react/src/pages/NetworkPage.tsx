/**
 * VTuber 關係網路頁:以聊天室管理員關係建立的網狀圖。
 */

import { useCallback, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import MainLayout from "../components/layout/MainLayout";
import NetworkGraph, { type NetworkGraphHandle } from "@/components/network/NetworkGraph";
import DetailPanel from "@/components/network/DetailPanel";
import NetworkToolbar from "@/components/network/NetworkToolbar";
import { useNetworkGraph } from "@/hooks/useNetworkGraph";

const PANEL_INSET = 340;

export default function NetworkPage() {
  const { data, isLoading, isError } = useNetworkGraph();
  const [searchParams, setSearchParams] = useSearchParams();
  const graphRef = useRef<NetworkGraphHandle | null>(null);

  const focusedId = searchParams.get("focus");

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

  return (
    <MainLayout>
      <div className="max-w-full">
        <h1 className="text-xl font-bold mb-3">VTuber 關係網路</h1>
        <div className="relative h-[calc(100vh-10.5rem)] min-h-[420px] rounded-xl overflow-hidden border border-slate-800 bg-[#080d15]">
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
                onFocusChange={setFocus}
                panelInset={focusedId ? PANEL_INSET : 0}
              />
              <NetworkToolbar
                data={data}
                onSelect={setFocus}
                onZoomIn={() => graphRef.current?.zoomIn()}
                onZoomOut={() => graphRef.current?.zoomOut()}
                onFitAll={() => graphRef.current?.fitAll()}
              />
              {focusedId && (
                <DetailPanel
                  data={data}
                  focusedId={focusedId}
                  onClose={() => setFocus(null)}
                  onFocusChange={setFocus}
                />
              )}
            </>
          )}
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          關係來源:過去直播聊天室中的管理員標記,雙方任一邊給予管理員身份即視為互相認識。
        </p>
      </div>
    </MainLayout>
  );
}
