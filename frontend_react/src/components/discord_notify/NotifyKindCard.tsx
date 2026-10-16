import React, { useRef, useState } from "react";
import { toast } from "react-hot-toast";
import { showFailureToast } from "@/components/common/ToastManager";
import { useSaveDiscordNotify, useSendDiscordTest } from "@/hooks/useDiscordNotify";
import type { DiscordGuildOptions, NotifyKind, NotifyKindConfig } from "@/types/discordNotify";
import {
  TEMPLATE_VARIABLES,
  renderTemplatePreview,
  roleDisplayText,
} from "@/utils/discordTemplate";

const KIND_TEXT: Record<NotifyKind, { title: string; description: string; sampleType: string }> = {
  live: {
    title: "直播開台",
    description: "直播開始的時候發送。待機室建立時不會發。",
    sampleType: "直播",
  },
  video: {
    title: "影片",
    description: "上傳長片、Shorts，或首播開始的時候發送。",
    sampleType: "影片",
  },
};

const inputClass =
  "w-full px-3 py-2 border border-gray-300 dark:border-zinc-600 rounded bg-white " +
  "dark:bg-zinc-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none " +
  "focus:ring-2 focus:ring-blue-400";

interface Props {
  kind: NotifyKind;
  initial: NotifyKindConfig;
  options: DiscordGuildOptions | undefined;
  channelName: string;
}

export function NotifyKindCard({ kind, initial, options, channelName }: Props) {
  const [draft, setDraft] = useState<NotifyKindConfig>(initial);
  const [saved, setSaved] = useState<NotifyKindConfig>(initial);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const save = useSaveDiscordNotify();
  const sendTest = useSendDiscordTest();

  const text = KIND_TEXT[kind];
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const guildId = options?.guild_id ?? "";
  const roles = options?.roles ?? [];

  const update = (fields: Partial<NotifyKindConfig>) => setDraft((d) => ({ ...d, ...fields }));

  const insertVariable = (variable: string) => {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? draft.template.length;
    const end = el?.selectionEnd ?? draft.template.length;
    const next = draft.template.slice(0, start) + variable + draft.template.slice(end);
    update({ template: next });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + variable.length, start + variable.length);
    });
  };

  const handleSave = async () => {
    try {
      const result = await save.mutateAsync({ kind, config: draft });
      setSaved(result[kind]);
      setDraft(result[kind]);
      toast.success(`${text.title}通知已儲存`);
    } catch (e) {
      showFailureToast(e instanceof Error ? e.message : "儲存失敗");
    }
  };

  const handleTest = async () => {
    try {
      await sendTest.mutateAsync(kind);
      toast.success("已發送測試訊息，到 Discord 看看吧");
    } catch (e) {
      showFailureToast(e instanceof Error ? e.message : "測試訊息發送失敗");
    }
  };

  const preview = renderTemplatePreview(draft.template, roleDisplayText(draft.role_id, guildId, roles), {
    title: "這是一則範例標題",
    url: "https://www.youtube.com/watch?v=xxxxxxxxxxx",
    channel: channelName,
    type: text.sampleType,
  });

  return (
    <section className="mb-6 p-4 border border-gray-200 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-900">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">{text.title}</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">{text.description}</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200 shrink-0">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => update({ enabled: e.target.checked })}
            className="w-4 h-4"
          />
          開啟
        </label>
      </div>

      <div className="space-y-4">
        <label className="block">
          <span className="block text-sm font-semibold mb-1 text-gray-800 dark:text-gray-200">
            發到哪個頻道
          </span>
          <select
            value={draft.discord_channel_id ?? ""}
            onChange={(e) => update({ discord_channel_id: e.target.value || null })}
            className={inputClass}
          >
            <option value="">請選擇</option>
            {options?.channels.map((c) => (
              <option key={c.id} value={c.id}>
                # {c.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="block text-sm font-semibold mb-1 text-gray-800 dark:text-gray-200">
            要 tag 的身分組
          </span>
          <select
            value={draft.role_id ?? ""}
            onChange={(e) => update({ role_id: e.target.value || null })}
            className={inputClass}
          >
            <option value="">不 tag</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id === guildId ? "@everyone（所有人）" : `@${r.name}`}
              </option>
            ))}
          </select>
        </label>

        <div>
          <span className="block text-sm font-semibold mb-1 text-gray-800 dark:text-gray-200">
            訊息內容
          </span>
          <div className="flex flex-wrap gap-2 mb-2">
            {TEMPLATE_VARIABLES.map((v) => (
              <button
                key={v.key}
                type="button"
                onClick={() => insertVariable(v.key)}
                className="px-2 py-1 text-xs rounded border border-gray-300 dark:border-zinc-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-zinc-700"
              >
                {v.label} <code className="text-gray-400">{v.key}</code>
              </button>
            ))}
          </div>
          <textarea
            ref={textareaRef}
            value={draft.template}
            onChange={(e) => update({ template: e.target.value })}
            rows={4}
            maxLength={1500}
            className={inputClass}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            點上面的按鈕可以插入對應的內容。有選身分組但內容裡沒放 tag 的話，會自動加在最前面。
          </p>
        </div>

        <div>
          <span className="block text-sm font-semibold mb-1 text-gray-800 dark:text-gray-200">
            預覽
          </span>
          <div className="whitespace-pre-wrap break-words text-sm px-3 py-2 rounded bg-[#313338] text-gray-100">
            {preview}
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          onClick={handleSave}
          disabled={!dirty || save.isPending || !draft.template.trim()}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {save.isPending ? "儲存中..." : "儲存"}
        </button>
        <button
          onClick={handleTest}
          disabled={dirty || sendTest.isPending || !saved.discord_channel_id}
          className="px-4 py-2 rounded border border-gray-300 dark:border-zinc-600 text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-zinc-700 disabled:opacity-50"
        >
          {sendTest.isPending ? "發送中..." : "發送測試訊息"}
        </button>
        {dirty && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            有修改尚未儲存，儲存後才能發送測試訊息
          </span>
        )}
      </div>
    </section>
  );
}
