import { useQuery } from "@tanstack/react-query";
import { API_BASE } from "@/lib/api";
import type { NetworkGraphData } from "@/types/network";

// 本機開發時可用 VITE_NETWORK_API_BASE 指向 dev server(python -m crawler serve),
// 不影響其他 API 的 base URL。
const NETWORK_API_BASE = import.meta.env.VITE_NETWORK_API_BASE || API_BASE;

async function fetchNetworkGraph(): Promise<NetworkGraphData> {
  const res = await fetch(`${NETWORK_API_BASE}/api/network/graph`);
  if (!res.ok) {
    throw new Error(`network graph 載入失敗:${res.status}`);
  }
  const data = await res.json();
  return { nodes: data.nodes ?? [], edges: data.edges ?? [] };
}

export function useNetworkGraph() {
  return useQuery({
    queryKey: ["network-graph"],
    queryFn: fetchNetworkGraph,
    staleTime: 1000 * 60 * 60, // 1 小時;關係資料每日更新,不需要更頻繁
  });
}
