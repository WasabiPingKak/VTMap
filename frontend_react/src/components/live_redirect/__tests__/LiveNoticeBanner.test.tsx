/**
 * LiveNoticeBanner：可關閉的臨時公告，關閉狀態記在 localStorage。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import LiveNoticeBanner from "@/components/live_redirect/LiveNoticeBanner";

const STORAGE_KEY = "liveRedirectNoticeDismissed:2026-09-websub";

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  // React 的 act() 需要這個旗標，否則會噴警告
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
});

async function renderBanner() {
  await act(async () => {
    root.render(<LiveNoticeBanner />);
  });
}

function closeButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('button[aria-label="關閉提示"]');
}

async function clickClose() {
  await act(async () => {
    closeButton()?.click();
  });
}

describe("LiveNoticeBanner", () => {
  it("預設顯示公告文字與關閉按鈕", async () => {
    await renderBanner();
    expect(container.textContent).toContain("YouTube 的開台通知服務");
    expect(container.textContent).toContain("待 YouTube 修復後服務會自動恢復正常");
    expect(closeButton()).not.toBeNull();
  });

  it("按關閉後隱藏，並把關閉狀態寫進 localStorage", async () => {
    await renderBanner();
    await clickClose();
    expect(container.textContent).toBe("");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("true");
  });

  it("localStorage 已記錄關閉時一開始就不顯示", async () => {
    localStorage.setItem(STORAGE_KEY, "true");
    await renderBanner();
    expect(container.textContent).toBe("");
  });

  it("localStorage 不可用時仍能顯示與關閉", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await renderBanner();
    expect(container.textContent).toContain("YouTube 的開台通知服務");
    await clickClose();
    expect(container.textContent).toBe("");
  });
});
