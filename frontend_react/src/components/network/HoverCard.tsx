/**
 * 節點 hover 小卡:頭像 + 名稱 + handle + 訂閱數 + 相鄰節點數 + 圓心距離。
 * 貼在滑鼠位置附近,靠近邊緣時翻到反側。
 */

import { useEffect, useRef, useState } from "react";
import type { LayoutNode } from "@/types/network";
import { formatSubscribers } from "./formatters";
import { channelDisplayName } from "./displayName";

export interface HoverCardData {
  node: LayoutNode;
  screenX: number;
  screenY: number;
  neighborCount: number;
  /** ego 模式下的環別:0 圓心 / 1 直接 / 2 隔兩層 / 3 更遠;null = 非 ego 模式 */
  ring: number | null;
}

interface HoverCardProps {
  info: HoverCardData;
}

const RING_LABEL: Record<number, string> = {
  0: "圓心本人",
  1: "直接關係",
  2: "隔兩層",
  3: "更遠",
};

const CURSOR_OFFSET = 16;

export default function HoverCard({ info }: HoverCardProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: info.screenX + CURSOR_OFFSET,
    top: info.screenY + CURSOR_OFFSET,
  });

  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = info.screenX + CURSOR_OFFSET;
    let top = info.screenY + CURSOR_OFFSET;
    if (left + rect.width > vw - 8) left = info.screenX - rect.width - CURSOR_OFFSET;
    if (top + rect.height > vh - 8) top = info.screenY - rect.height - CURSOR_OFFSET;
    if (left < 8) left = 8;
    if (top < 8) top = 8;
    setPos({ left, top });
  }, [info.screenX, info.screenY, info.node.node.channel_id]);

  const node = info.node.node;
  const title = channelDisplayName(node);
  const ringLabel = info.ring !== null ? RING_LABEL[info.ring] : null;

  return (
    <div
      ref={cardRef}
      className="pointer-events-none fixed z-20 flex min-w-[200px] max-w-[280px] flex-col gap-2 rounded-lg border border-slate-700 bg-slate-900/95 p-3 shadow-lg backdrop-blur-sm"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="flex items-start gap-2.5">
        {node.thumbnail ? (
          <img
            src={node.thumbnail}
            alt=""
            className="h-10 w-10 flex-shrink-0 rounded-full border border-slate-700"
          />
        ) : (
          <div className="h-10 w-10 flex-shrink-0 rounded-full border border-slate-700 bg-slate-800" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-slate-100">{title}</div>
          {node.handle && (
            <div className="truncate text-xs text-slate-400">@{node.handle}</div>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-0.5 border-t border-slate-800 pt-2 text-xs text-slate-300">
        <div className="flex justify-between gap-2">
          <span className="text-slate-500">訂閱數</span>
          <span className="truncate">{formatSubscribers(node.subscriber_count)}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-slate-500">相鄰節點</span>
          <span>{info.neighborCount} 個</span>
        </div>
        {ringLabel && (
          <div className="flex justify-between gap-2">
            <span className="text-slate-500">與圓心距離</span>
            <span>{ringLabel}</span>
          </div>
        )}
      </div>
    </div>
  );
}
