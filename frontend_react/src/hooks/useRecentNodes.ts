import { useQuery } from "@tanstack/react-query";
import { API_BASE } from "@/lib/api";
import type { RecentNode } from "@/types/network";

// 與 useNetworkGraph 一致:本機開發可 override 到 crawler dev server
const NETWORK_API_BASE = import.meta.env.VITE_NETWORK_API_BASE || API_BASE;

async function fetchRecentNodes(limit: number): Promise<RecentNode[]> {
  const res = await fetch(`${NETWORK_API_BASE}/api/network/recent?limit=${limit}`);
  if (!res.ok) {
    throw new Error(`最新加入清單載入失敗:${res.status}`);
  }
  const data = await res.json();
  return (data.nodes ?? []) as RecentNode[];
}

export function useRecentNodes(limit = 20) {
  return useQuery({
    queryKey: ["network-recent", limit],
    queryFn: () => fetchRecentNodes(limit),
    staleTime: 1000 * 60 * 10, // 10 分鐘;新頻道發現頻率不高,不必更頻繁
  });
}
