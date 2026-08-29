import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

export interface QueueTask {
  id: number;
  kind: string;
  status: string;
  priority: number;
  attempts: number;
  channel_id: string | null;
  video_id: string | null;
  last_error: string | null;
  created_at: string | null;
  updated_at: string | null;
  channel_title: string | null;
  channel_handle: string | null;
  channel_thumbnail: string | null;
}

export interface QueueSummaryRow {
  kind: string;
  status: string;
  count: number;
}

export interface QueueDoneTask {
  id: number;
  kind: string;
  channel_id: string | null;
  video_id: string | null;
  updated_at: string | null;
  channel_title: string | null;
  channel_handle: string | null;
}

export interface QueueDetail {
  tasks: QueueTask[];
  summary: QueueSummaryRow[];
  recent_done: QueueDoneTask[];
}

async function fetchQueueDetail(): Promise<QueueDetail> {
  const res = await apiFetch("/api/network/admin/queue");
  if (!res.ok) {
    throw new Error(`佇列載入失敗:${res.status}`);
  }
  const data = await res.json();
  return {
    tasks: data.tasks ?? [],
    summary: data.summary ?? [],
    recent_done: data.recent_done ?? [],
  };
}

export function useNetworkQueue(enabled: boolean) {
  return useQuery({
    queryKey: ["network-queue"],
    queryFn: fetchQueueDetail,
    enabled,
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}
