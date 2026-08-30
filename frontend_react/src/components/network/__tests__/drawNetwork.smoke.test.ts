// 臨時煙霧測試:用 mock ctx 執行 drawNetwork,確認不噴錯且有畫節點與標籤
import { describe, it, expect } from "vitest";
import { computeLayout } from "../layout";
import { createStarField, drawNetwork, type RenderState } from "../renderers";
import type { NetworkGraphData } from "@/types/network";

function makeCtx() {
  const calls: Record<string, number> = {};
  const gradient = { addColorStop: () => {} };
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(target, prop: string) {
      if (prop === "measureText") {
        return (text: string) => {
          calls.measureText = (calls.measureText ?? 0) + 1;
          return { width: text.length * 8 };
        };
      }
      if (prop === "createRadialGradient") return () => gradient;
      if (prop in target) return target[prop];
      return (...args: unknown[]) => {
        void args;
        calls[prop] = (calls[prop] ?? 0) + 1;
      };
    },
    set(target, prop: string, value) {
      target[prop] = value;
      return true;
    },
  };
  const ctx = new Proxy({} as Record<string, unknown>, handler);
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const data: NetworkGraphData = {
  nodes: [
    { channel_id: "UC_a", title: "頻道A", handle: "@a", thumbnail: null, in_vtmap: true },
    { channel_id: "UC_b", title: "頻道B", handle: "@b", thumbnail: null, in_vtmap: false },
  ],
  edges: [{ a: "UC_a", b: "UC_b", evidence_count: 1, last_seen_video_at: null, evidence: [] }],
};

describe("drawNetwork smoke", () => {
  it("正常縮放下繪製節點與標籤,不噴錯", () => {
    const layout = computeLayout(data);
    const state: RenderState = {
      layout,
      images: new Map(),
      hoveredId: null,
      focusedId: null,
      highlightIds: null,
      hopDistances: null,
      starField: createStarField(10),
    };
    const { ctx, calls } = makeCtx();
    drawNetwork(ctx, { x: 0, y: 0, scale: 1 }, 1600, 900, state);
    expect(calls.fillText ?? 0).toBeGreaterThan(0); // 有畫標籤(或首字)
    expect(calls.stroke ?? 0).toBeGreaterThan(0); // 有畫邊/邊框
  });
});
