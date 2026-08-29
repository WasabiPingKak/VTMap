// React 入口檔案不 export 元件，Fast Refresh 無法作用於此檔案，
// 僅影響開發時 HMR 效率（最差情況為整頁 reload），不影響 production。
/* eslint-disable react-refresh/only-export-components */
import React, { Suspense, useEffect } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "react-hot-toast";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import ReactGA from "react-ga4";

const gaId = import.meta.env.VITE_GA_MEASUREMENT_ID;
if (gaId) {
  ReactGA.initialize(gaId);
}

import VideoExplorerPage from "./pages/VideoExplorerPage";
import ThanksPage from "./pages/ThanksPage";
import AuthorizeChannelPage from "./pages/AuthorizeChannelPage";
import AuthLoadingPage from "./pages/AuthLoadingPage";
import PrivacyPolicyPage from "./pages/PrivacyPolicyPage";
import ChannelSelectorPage from "./pages/ChannelSelectorPage";
import TrendingGamesPage from "./pages/TrendingGamesPage";
import GameAliasPage from "./pages/GameAliasPage";
import CategoryAliasPage from "./pages/CategoryAliasPage";
import ChangelogPage from "./pages/ChangelogPage";
import MySettingsPage from "./pages/MySettingsPage";
import ChannelCategoryEditorPage from "./pages/ChannelCategoryEditorPage";
import QuickCategoryEditorPage from "./pages/QuickCategoryEditorPage";
import LiveRedirectPage from "./pages/LiveRedirectPage";
import DonatePage from "@/pages/DonatePage";
import ReviewPage from "./pages/ReviewPage";
import NetworkPage from "./pages/NetworkPage";

import "flag-icons/css/flag-icons.min.css";
import "./style.css";

/* --- 建立 QueryClient 實例 --- */
const queryClient = new QueryClient();

/* --- 只有在正式環境啟用 persist 快取（跨重整）--- */
//if (!import.meta.env.DEV) {
import("@tanstack/react-query-persist-client").then(({ persistQueryClient }) => {
  import("@tanstack/query-sync-storage-persister").then(({ createSyncStoragePersister }) => {
    const localStoragePersister = createSyncStoragePersister({
      storage: window.localStorage,
    });

    persistQueryClient({
      queryClient,
      persister: localStoragePersister,
      maxAge: 1000 * 60 * 60 * 12,
      buster: __BUILD_TIMESTAMP__,
    });
  });
});
//}

/* --- 可選：提供給 DevTools Console 測試 invalidate 用 --- */
if (import.meta.env.DEV) {
  window.queryClient = queryClient;
}

/* ✅ 自訂 Hook：每次頁面切換時上報 GA page_view */
function usePageTracking() {
  const location = useLocation();
  useEffect(() => {
    if (gaId) {
      ReactGA.send({ hitType: "pageview", page: location.pathname + location.search });
    }
  }, [location]);
}

/* ✅ 包成一層 Layout，以使用 useLocation 追蹤 */
function AppRoutes() {
  usePageTracking();

  return (
    <Suspense fallback={<div>Loading…</div>}>
      <Routes>
        {/* 公開頁面 */}
        <Route path="/" element={<Navigate to="/live-redirect" replace />} />
        <Route path="/videos" element={<VideoExplorerPage />} />
        <Route path="/channels" element={<ChannelSelectorPage />} />
        <Route path="/authorize-channel" element={<AuthorizeChannelPage />} />
        <Route path="/thanks" element={<ThanksPage />} />
        <Route path="/privacy" element={<PrivacyPolicyPage />} />
        <Route path="/trending" element={<TrendingGamesPage />} />
        <Route path="/game-aliases" element={<GameAliasPage />} />
        <Route path="/category-aliases" element={<CategoryAliasPage />} />
        <Route path="/changelog" element={<ChangelogPage />} />
        <Route path="/my-settings" element={<MySettingsPage />} />
        <Route path="/my-category-editor" element={<ChannelCategoryEditorPage />} />
        <Route path="/quick-category-editor/:channelId" element={<QuickCategoryEditorPage />} />
        <Route path="/auth-loading" element={<AuthLoadingPage />} />
        <Route path="/live-redirect" element={<LiveRedirectPage />} />
        <Route path="/donate" element={<DonatePage />} />
        <Route path="/review/:channelId/:year" element={<ReviewPage />} />
        <Route path="/network" element={<NetworkPage />} />

        {/* 其他路徑 → redirect 提示 */}
        <Route
          path="*"
          element={
            <div className="p-4">
              <p>
                請訪問{" "}
                <a href="/videos" className="text-blue-600 underline">
                  /videos
                </a>
              </p>
            </div>
          }
        />
      </Routes>
    </Suspense>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {(() => {
      const currentHost = window.location.hostname;
      if (currentHost === "vtuber-channel-analyzer-v3.web.app") {
        window.location.href =
          "https://www.vtubertrailmap.com" + window.location.pathname + window.location.search;
        return null;
      }
      return (
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
          <Toaster position="top-center" />
          {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
        </QueryClientProvider>
      );
    })()}
  </React.StrictMode>
);
