import { useQuery } from "@tanstack/react-query";
import { API_BASE } from "@/lib/api";

// 與 useNetworkGraph / useRecentNodes 一致
const NETWORK_API_BASE = import.meta.env.VITE_NETWORK_API_BASE || API_BASE;

async function fetchQueueRank(channelId: string): Promise<number | null> {
  const res = await fetch(
    `${NETWORK_API_BASE}/api/network/queue-rank/${encodeURIComponent(channelId)}`,
  );
  if (!res.ok) {
    throw new Error(`佇列順位載入失敗:${res.status}`);
  }
  const data = await res.json();
  return typeof data.rank === "number" ? data.rank : null;
}

/** 只在 enabled=true(節點未掃描且有 id)時才發請求;5 分鐘 cache,順位變化不快 */
export function useQueueRank(channelId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["network-queue-rank", channelId],
    queryFn: () => fetchQueueRank(channelId as string),
    enabled: !!channelId && enabled,
    staleTime: 1000 * 60 * 5,
  });
}
