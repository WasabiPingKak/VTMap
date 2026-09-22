import { useState } from "react";

/**
 * 塔臺頁面的臨時公告。
 *
 * 背景：Google 的 WebSub hub（YouTube 開台推播來源）自 2026-09 起不穩定，
 * 訂閱續訂大量失敗，租約到期後部分頻道的開台不會推播進 notify queue，
 * 塔臺就不會顯示。hub 恢復、每日續訂排程重新訂閱成功後，把這個元件從頁面移除即可。
 *
 * 關閉狀態存 localStorage，key 帶事件代號，之後若有新公告換 key 就會重新顯示。
 */
const STORAGE_KEY = "liveRedirectNoticeDismissed:2026-09-websub";

const NOTICE_TEXT =
  "YouTube 的開台通知服務從 9 月中開始不穩定，部分頻道的開台可能不會出現在這裡。" +
  "待 YouTube 修復後服務會自動恢復正常。";

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    // localStorage 被停用時當作沒關過
    return false;
  }
}

function writeDismissed(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, "true");
  } catch {
    // localStorage 滿了或被停用就忽略，這次瀏覽仍會隱藏
  }
}

export default function LiveNoticeBanner() {
  const [dismissed, setDismissed] = useState(readDismissed);

  if (dismissed) return null;

  const handleDismiss = () => {
    writeDismissed();
    setDismissed(true);
  };

  return (
    <div className="flex items-start gap-3 bg-yellow-50 dark:bg-yellow-100/10 border border-yellow-200 dark:border-yellow-300/30 rounded-xl p-4 mb-4 text-sm text-yellow-800 dark:text-yellow-300">
      <p className="flex-1 leading-relaxed">{NOTICE_TEXT}</p>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="關閉提示"
        className="shrink-0 px-1 text-base leading-none text-yellow-600 dark:text-yellow-400 hover:text-yellow-900 dark:hover:text-yellow-100"
      >
        ✕
      </button>
    </div>
  );
}
