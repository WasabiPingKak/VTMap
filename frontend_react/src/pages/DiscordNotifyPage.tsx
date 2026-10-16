import React, { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import MainLayout from "../components/layout/MainLayout";
import { NotifyKindCard } from "@/components/discord_notify/NotifyKindCard";
import { showPermissionDeniedToast } from "@/components/common/ToastManager";
import { useMyChannelId } from "@/hooks/useMyChannelId";
import { useDiscordGuildOptions, useDiscordNotifyConfig } from "@/hooks/useDiscordNotify";
import type { NotifyKind } from "@/types/discordNotify";

const KINDS: NotifyKind[] = ["live", "video"];

export default function DiscordNotifyPage() {
  const navigate = useNavigate();
  const { data: me, isLoading: meLoading } = useMyChannelId();
  const isAdmin = Boolean(me?.isAdmin);

  const config = useDiscordNotifyConfig(isAdmin);
  const options = useDiscordGuildOptions(isAdmin);

  // 目前只開放管理員使用
  useEffect(() => {
    if (!meLoading && !isAdmin) {
      showPermissionDeniedToast("這個功能目前尚未開放");
      navigate("/");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在登入狀態確定後檢查一次
  }, [meLoading, isAdmin]);

  if (meLoading || !isAdmin || config.isLoading) {
    return (
      <MainLayout>
        <div className="max-w-xl mx-auto p-6 text-center text-gray-500 dark:text-gray-300">
          載入中...
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <div className="max-w-xl mx-auto p-6">
        <Link
          to="/my-settings"
          className="text-sm text-gray-500 dark:text-gray-400 hover:underline"
        >
          ← 回到我的頻道設定
        </Link>
        <h1 className="text-2xl font-bold mt-2 mb-2 text-gray-900 dark:text-gray-100">
          Discord 通知
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
          開台或上傳新影片時，機器人會自動在你的 Discord 伺服器發訊息。
          在 Discord 裡輸入 <code>/notify</code> 也可以修改這些設定。
        </p>

        {config.error && (
          <p className="mb-4 text-sm text-red-600 dark:text-red-400">{config.error.message}</p>
        )}
        {options.error && (
          <p className="mb-4 text-sm text-red-600 dark:text-red-400">
            {options.error.message}。請確認機器人已經加入你的 Discord 伺服器。
          </p>
        )}

        {config.data &&
          KINDS.map((kind) => (
            <NotifyKindCard
              // 卡片自己管理編輯中與已儲存的狀態，儲存其中一張不影響另一張的未儲存修改
              key={kind}
              kind={kind}
              initial={config.data[kind]}
              options={options.data}
              channelName={me?.name ?? ""}
            />
          ))}
      </div>
    </MainLayout>
  );
}
