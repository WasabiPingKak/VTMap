/**
 * SidebarMenu 的「關係網路」入口由 VITE_ENABLE_NETWORK 控制：
 * staging / 本機開發顯示，production 隱藏。
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/hooks/useMyChannelId", () => ({
  useMyChannelId: () => ({ data: { channelId: null, isAdmin: false } }),
}));

// SmartLink 依賴 react-router 的 useNavigate，這裡換成純 <a> 避免掛 Router
vi.mock("@/components/common/SmartLink", () => ({
  default: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  // React 的 act() 需要這個旗標，否則會噴警告
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllEnvs();
});

/** 旗標在 module 載入時讀取，所以每次都要 reset modules 重新 import */
async function renderSidebar(enableNetwork: string) {
  vi.stubEnv("VITE_ENABLE_NETWORK", enableNetwork);
  vi.resetModules();
  const { default: SidebarMenu } = await import("@/components/common/SidebarMenu");
  await act(async () => {
    root.render(<SidebarMenu collapsed={false} setCollapsed={() => {}} />);
  });
}

function navLinks(): HTMLAnchorElement[] {
  return Array.from(container.querySelectorAll<HTMLAnchorElement>("nav a"));
}

function findLink(label: string): HTMLAnchorElement | undefined {
  return navLinks().find((a) => a.textContent === label);
}

describe("SidebarMenu 關係網路入口", () => {
  it("VITE_ENABLE_NETWORK=true 時顯示「關係網路」並連到 /network", async () => {
    await renderSidebar("true");
    const link = findLink("關係網路");
    expect(link).toBeDefined();
    expect(link?.getAttribute("href")).toBe("/network");
  });

  it("VITE_ENABLE_NETWORK=false 時不顯示「關係網路」", async () => {
    await renderSidebar("false");
    expect(findLink("關係網路")).toBeUndefined();
  });

  it("旗標關閉時其他選單項目不受影響", async () => {
    await renderSidebar("false");
    expect(findLink("檢視所有頻道")?.getAttribute("href")).toBe("/channels");
    expect(findLink("分類總表｜遊戲")?.getAttribute("href")).toBe("/game-aliases");
  });
});
