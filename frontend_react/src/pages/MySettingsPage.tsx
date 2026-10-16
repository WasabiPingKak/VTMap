import React, { useEffect } from "react";
import { useMySettings } from "@/hooks/useMySettings";
import { useMyChannelId } from "@/hooks/useMyChannelId";
import { PublicToggleSection } from "@/components/profile_settings/PublicToggleSection";
import { CountryFlagSelector } from "@/components/profile_settings/CountryFlagSelector";
import { LiveStatusToggleSection } from "@/components/profile_settings/LiveStatusToggleSection";
import {
  showFailureToast,
  showLoginRequiredToast,
  showPermissionDeniedToast,
} from "@/components/common/ToastManager";
import { AdminRevokeSection } from "@/components/profile_settings/AdminRevokeSection";
import ChannelSelectorCard from "@/components/channels/ChannelSelectorCard";
import MainLayout from "../components/layout/MainLayout";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "react-hot-toast";
import { MdAnalytics } from "react-icons/md";
import { FaDiscord } from "react-icons/fa";
import { apiPost } from "@/lib/api";

export default function MySettingsPage() {
  const {
    enabled,
    setEnabled,
    selectedCountries,
    setSelectedCountries,
    loading,
    handleSave,
    channelInfo,
    visibleLive,
    setVisibleLive,
  } = useMySettings();

  const {
    data: me,
    isLoading: meLoading,
    error: meError,
  } = useMyChannelId();

  const navigate = useNavigate();

  // ✅ 匿名未登入使用者處理
  useEffect(() => {
    if (!meLoading && me?.channelId === null) {
      showLoginRequiredToast("請先登入以編輯頻道設定");
      navigate("/");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在登入狀態確定後檢查一次
  }, [meLoading, me]);

  // ✅ 權限驗證：登入者只能看自己的頻道設定
  useEffect(() => {
    const myId = me?.channelId;
    const targetId = channelInfo?.channel_id;

    if (
      meError ||
      (!meLoading && myId && targetId && myId !== targetId)
    ) {
      showPermissionDeniedToast("您沒有權限查看設定頁面");
      navigate("/");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在相關狀態變動時檢查權限
  }, [meLoading, me, meError, channelInfo?.channel_id]);

  const handleLogout = async () => {
    try {
      const res = await apiPost("/api/logout", {});
      if (!res.ok) throw new Error("Logout failed");
      toast.success("已成功登出");
      navigate("/");
    } catch {
      showFailureToast("登出失敗");
    }
  };

  // ✅ 載入狀態
  if (meLoading || !channelInfo?.channel_id) {
    return (
      <MainLayout>
        <div className="max-w-xl mx-auto p-6 text-center text-gray-500 dark:text-gray-300">
          載入中...
        </div>
      </MainLayout>
    );
  }

  // ✅ 匿名者導向中（避免畫面閃爍）
  if (me?.channelId === null) {
    return null;
  }

  return (
    <MainLayout>
      <div className="max-w-xl mx-auto p-6">
        <h1 className="text-2xl font-bold mb-6 text-gray-900 dark:text-gray-100">
          我的頻道設定
        </h1>

        {channelInfo && (
          <div className="mb-6">
            <ChannelSelectorCard channel={channelInfo as Record<string, unknown> & typeof channelInfo} />
          </div>
        )}

        {channelInfo?.channel_id && (
          <div className="mt-2 mb-4 space-y-2">
            <div className="bg-yellow-50 dark:bg-yellow-100/10 border border-yellow-300 dark:border-yellow-300/30 rounded px-4 py-3">
              <p className="text-sm text-yellow-800 dark:text-yellow-200">
                有些影片系統可能分類不出來，看一眼👀{" "}
                <Link
                  to={`/quick-category-editor/${channelInfo.channel_id}`}
                  className="underline font-semibold text-yellow-900 dark:text-yellow-300 hover:text-yellow-700 dark:hover:text-yellow-400"
                >
                  快速分類
                </Link>{" "}
                協助整理，讓分析更精準！
              </p>
            </div>

            <div className="bg-gray-50 dark:bg-zinc-800 border border-gray-300 dark:border-zinc-600 rounded px-4 py-3">
              <Link
                to={`/videos?channel=${channelInfo.channel_id}`}
                className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-100 font-bold underline"
              >
                <MdAnalytics className="w-5 h-5" />
                查看我的頻道頁面
              </Link>
            </div>

            {me?.isAdmin && (
              <div className="bg-gray-50 dark:bg-zinc-800 border border-gray-300 dark:border-zinc-600 rounded px-4 py-3">
                <Link
                  to="/discord-notify"
                  className="flex items-center gap-2 text-sm text-gray-800 dark:text-gray-100 font-bold underline"
                >
                  <FaDiscord className="w-5 h-5" />
                  Discord 開台與新影片通知
                </Link>
              </div>
            )}
          </div>
        )}

        <PublicToggleSection
          enabled={enabled}
          onChange={setEnabled}
        />

        <LiveStatusToggleSection
          visible={visibleLive}
          onChange={setVisibleLive}
        />

        <CountryFlagSelector
          selected={selectedCountries}
          onChange={setSelectedCountries}
        />

        <button
          onClick={handleSave}
          disabled={loading}
          className="mt-4 bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
        >
          儲存設定
        </button>

        <button
          onClick={handleLogout}
          className="mt-4 ml-4 bg-gray-500 dark:bg-gray-600 text-white px-4 py-2 rounded hover:bg-gray-600 dark:hover:bg-gray-500"
        >
          登出
        </button>

        {me?.isAdmin && <AdminRevokeSection />}
      </div>
    </MainLayout>
  );
}
