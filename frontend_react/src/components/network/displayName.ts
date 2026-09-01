/** 頻道顯示名稱:正式名稱優先,其次 @handle,最後 channel id。
 *  介面上只用到這三欄,不綁 NetworkNode 完整型別,方便 RecentNode 等變體共用。 */

interface NameCarrier {
  channel_id: string;
  title: string | null;
  handle: string | null;
}

export function channelDisplayName(node: NameCarrier): string {
  return node.title || node.handle || node.channel_id;
}

export function channelInitial(node: NameCarrier): string {
  const name = channelDisplayName(node).replace(/^@/, "");
  return (name[0] ?? "?").toUpperCase();
}
