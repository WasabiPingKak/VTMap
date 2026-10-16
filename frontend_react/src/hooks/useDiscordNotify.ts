import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiPost } from "@/lib/api";
import type {
  DiscordGuildOptions,
  DiscordNotifyConfig,
  NotifyKind,
  NotifyKindConfig,
} from "@/types/discordNotify";

const CONFIG_KEY = ["discord-notify-config"];
const OPTIONS_KEY = ["discord-notify-guild-options"];

async function readJson<T>(res: Response, fallbackMessage: string): Promise<T> {
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || fallbackMessage);
  }
  return res.json();
}

export function useDiscordNotifyConfig(enabled: boolean) {
  return useQuery<DiscordNotifyConfig>({
    queryKey: CONFIG_KEY,
    queryFn: async () =>
      readJson(await apiFetch("/api/discord-notify/config"), "讀取通知設定失敗"),
    enabled,
    // 設定頁要看到最新狀態，不使用長時間快取
    staleTime: 0,
    gcTime: 1000 * 60,
    retry: false,
  });
}

export function useDiscordGuildOptions(enabled: boolean) {
  return useQuery<DiscordGuildOptions>({
    queryKey: OPTIONS_KEY,
    queryFn: async () =>
      readJson(await apiFetch("/api/discord-notify/guild-options"), "讀取 Discord 頻道清單失敗"),
    enabled,
    staleTime: 0,
    gcTime: 1000 * 60,
    retry: false,
  });
}

export function useSaveDiscordNotify() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ kind, config }: { kind: NotifyKind; config: NotifyKindConfig }) => {
      const res = await apiFetch("/api/discord-notify/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, ...config }),
      });
      return readJson<DiscordNotifyConfig>(res, "儲存失敗");
    },
    onSuccess: (data) => {
      queryClient.setQueryData(CONFIG_KEY, data);
    },
  });
}

export function useSendDiscordTest() {
  return useMutation({
    mutationFn: async (kind: NotifyKind) =>
      readJson(await apiPost("/api/discord-notify/test", { kind }), "測試訊息發送失敗"),
  });
}
