// Discord 通知訊息的預覽渲染，規則與後端 config_store.render_message 一致

export const TEMPLATE_VARIABLES = [
  { key: "{title}", label: "標題" },
  { key: "{url}", label: "連結" },
  { key: "{channel}", label: "頻道名稱" },
  { key: "{type}", label: "類型" },
  { key: "{role}", label: "tag 身分組" },
] as const;

const PLACEHOLDER_PATTERN = /\{(title|url|channel|type|role)\}/g;

export interface PreviewContext {
  title: string;
  url: string;
  channel: string;
  type: string;
}

/**
 * 產生預覽文字。
 * roleText 為空字串代表不 tag，有 tag 但模板沒有 {role} 時放在開頭。
 */
export function renderTemplatePreview(
  template: string,
  roleText: string,
  context: PreviewContext,
): string {
  let source = template;
  if (roleText && !source.includes("{role}")) {
    source = `{role} ${source}`;
  }
  const values: Record<string, string> = { ...context, role: roleText };
  return source.replace(PLACEHOLDER_PATTERN, (_, key: string) => values[key] ?? "").trim();
}

/** @everyone 身分組的 id 等於伺服器 id */
export function roleDisplayText(
  roleId: string | null,
  guildId: string,
  roles: { id: string; name: string }[],
): string {
  if (!roleId) return "";
  if (roleId === guildId) return "@everyone";
  const role = roles.find((r) => r.id === roleId);
  return `@${role?.name ?? "身分組"}`;
}
