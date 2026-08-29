/**
 * 關係網路資料蒐集佇列(管理員限定):任務級明細與統計。
 */

import { Link } from "react-router-dom";
import { FaArrowLeft } from "react-icons/fa";
import MainLayout from "../components/layout/MainLayout";
import { useMyChannelId } from "@/hooks/useMyChannelId";
import {
  useNetworkQueue,
  type QueueSummaryRow,
  type QueueTask,
} from "@/hooks/useNetworkQueue";

const KIND_LABELS: Record<string, string> = {
  list_videos: "整理直播清單",
  fetch_chat: "讀取聊天室紀錄",
  check_qualification: "確認頻道資格",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "排隊中",
  running: "處理中",
  failed: "失敗",
  done: "已完成",
};

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200",
  running: "bg-sky-200 text-sky-800 dark:bg-sky-800 dark:text-sky-100",
  failed: "bg-red-200 text-red-800 dark:bg-red-900 dark:text-red-100",
};

function formatTime(iso: string | null): string {
  if (!iso) return "";
  return iso.slice(5, 16).replace("T", " ");
}

function SummaryChips({ summary }: { summary: QueueSummaryRow[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {summary.map((row) => (
        <span
          key={`${row.kind}-${row.status}`}
          className="rounded-full border border-gray-300 dark:border-zinc-700 px-3 py-1 text-sm"
        >
          {KIND_LABELS[row.kind] ?? row.kind}・{STATUS_LABELS[row.status] ?? row.status}:
          <span className="font-bold ml-1">{row.count}</span>
        </span>
      ))}
    </div>
  );
}

function TaskRow({ task }: { task: QueueTask }) {
  return (
    <tr className="border-b border-gray-200 dark:border-zinc-800">
      <td className="px-2 py-2">
        <span
          className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLES[task.status] ?? ""}`}
        >
          {STATUS_LABELS[task.status] ?? task.status}
        </span>
      </td>
      <td className="px-2 py-2 text-sm whitespace-nowrap">{KIND_LABELS[task.kind] ?? task.kind}</td>
      <td className="px-2 py-2">
        <div className="flex items-center gap-2 min-w-0">
          {task.channel_thumbnail && (
            <img src={task.channel_thumbnail} alt="" className="w-6 h-6 rounded-full shrink-0" />
          )}
          <span className="truncate text-sm">
            {task.channel_title || task.channel_handle || task.channel_id || "—"}
          </span>
        </div>
      </td>
      <td className="px-2 py-2 text-sm">
        {task.video_id && (
          <a
            href={`https://www.youtube.com/watch?v=${task.video_id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sky-600 dark:text-sky-400 hover:underline"
          >
            {task.video_id}
          </a>
        )}
      </td>
      <td className="px-2 py-2 text-sm text-center">
        {task.priority > 0 ? (
          <span className="text-amber-600 dark:text-amber-400 font-bold">插隊 {task.priority}</span>
        ) : (
          "—"
        )}
      </td>
      <td className="px-2 py-2 text-sm text-center">{task.attempts}</td>
      <td className="px-2 py-2 text-xs text-gray-500 whitespace-nowrap">
        {formatTime(task.created_at)}
      </td>
      <td className="px-2 py-2 text-xs text-red-500 max-w-[280px] truncate" title={task.last_error ?? ""}>
        {task.last_error ?? ""}
      </td>
    </tr>
  );
}

export default function NetworkQueuePage() {
  const { data: me, isLoading: meLoading } = useMyChannelId();
  const isAdmin = Boolean(me?.isAdmin);
  const { data, isLoading, isError } = useNetworkQueue(isAdmin);

  return (
    <MainLayout>
      <div className="max-w-6xl mx-auto">
        <Link
          to="/network"
          className="inline-flex items-center gap-1 text-sm text-sky-600 dark:text-sky-400 hover:underline mb-2"
        >
          <FaArrowLeft className="w-3 h-3" />
          回到關係網路
        </Link>
        <h1 className="text-xl font-bold mb-4">關係網路・資料蒐集佇列</h1>

        {meLoading && <p>載入中…</p>}
        {!meLoading && !isAdmin && (
          <p className="text-gray-500">這個頁面僅限管理員檢視。</p>
        )}

        {isAdmin && (
          <>
            {isLoading && <p>佇列載入中…</p>}
            {isError && <p className="text-red-500">佇列資料載入失敗,請稍後再試。</p>}
            {data && (
              <div className="space-y-6">
                <SummaryChips summary={data.summary} />

                <section>
                  <h2 className="font-bold mb-2">
                    待處理任務({data.tasks.length}
                    {data.tasks.length >= 500 ? "+,僅顯示前 500 筆" : ""})
                  </h2>
                  <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-zinc-800">
                    <table className="w-full text-left">
                      <thead className="bg-gray-50 dark:bg-zinc-900 text-xs text-gray-500">
                        <tr>
                          <th className="px-2 py-2">狀態</th>
                          <th className="px-2 py-2">工作</th>
                          <th className="px-2 py-2">頻道</th>
                          <th className="px-2 py-2">影片</th>
                          <th className="px-2 py-2">優先</th>
                          <th className="px-2 py-2">嘗試</th>
                          <th className="px-2 py-2">加入時間</th>
                          <th className="px-2 py-2">錯誤</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.tasks.map((task) => (
                          <TaskRow key={task.id} task={task} />
                        ))}
                        {data.tasks.length === 0 && (
                          <tr>
                            <td colSpan={8} className="px-2 py-6 text-center text-gray-500">
                              目前沒有待處理的任務。
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section>
                  <h2 className="font-bold mb-2">最近完成</h2>
                  <ul className="text-sm space-y-1">
                    {data.recent_done.map((task) => (
                      <li key={task.id} className="text-gray-600 dark:text-gray-300">
                        {formatTime(task.updated_at)}・{KIND_LABELS[task.kind] ?? task.kind}・
                        {task.channel_title || task.channel_handle || task.channel_id}
                        {task.video_id && `(${task.video_id})`}
                      </li>
                    ))}
                    {data.recent_done.length === 0 && (
                      <li className="text-gray-500">還沒有完成的任務。</li>
                    )}
                  </ul>
                </section>
              </div>
            )}
          </>
        )}
      </div>
    </MainLayout>
  );
}
