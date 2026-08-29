/** 頻道顯示名稱:正式名稱優先,其次 @handle,最後 channel id。 */

import type { NetworkNode } from "@/types/network";

export function channelDisplayName(node: NetworkNode): string {
  return node.title || node.handle || node.channel_id;
}

export function channelInitial(node: NetworkNode): string {
  const name = channelDisplayName(node).replace(/^@/, "");
  return (name[0] ?? "?").toUpperCase();
}
