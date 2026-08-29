import { describe, it, expect } from "vitest";
import {
  computeLabelMetrics,
  HEX_RADIUS,
  tokenize,
  wrapLabel,
  WORST_FONT,
  type MeasureFn,
} from "../labelMetrics";

// 測試用測量:CJK 每字 20、其他每字 10
const measure: MeasureFn = (text) => {
  let width = 0;
  for (const ch of text) {
    width += /[⺀-鿿]/.test(ch) ? 20 : 10;
  }
  return width;
};

describe("tokenize", () => {
  it("中文逐字、英文逐詞、保留空白邊界", () => {
    expect(tokenize("王顧採 Ch.")).toEqual(["王", "顧", "採", " ", "Ch."]);
    expect(tokenize("ReLive_Winnie")).toEqual(["ReLive_Winnie"]);
  });

  it("日文假名逐字", () => {
    expect(tokenize("もみじ")).toEqual(["も", "み", "じ"]);
  });
});

describe("wrapLabel", () => {
  it("短名字不換行", () => {
    const { lines, widest } = wrapLabel("短名", measure, 120);
    expect(lines).toEqual(["短名"]);
    expect(widest).toBe(40);
  });

  it("長名字換行且每行不超過上限", () => {
    // 「王顧採 Ch. 六埕順揚宮 主委」:8 個中文字(各20)+ "Ch."(30)+ 空白
    const { lines } = wrapLabel("王顧採 Ch. 六埕順揚宮 主委", measure, 100);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(measure(line)).toBeLessThanOrEqual(100);
    }
    // 完整內容保留(不截斷):所有字元都在
    expect(lines.join("").replace(/\s/g, "")).toBe("王顧採Ch.六埕順揚宮主委".replace(/\s/g, ""));
  });

  it("英文長詞不從中折斷", () => {
    const { lines } = wrapLabel("word 一二三四五六 another", measure, 80);
    for (const line of lines) {
      // 每個英文詞保持完整
      expect(line).not.toMatch(/wor$|^rd/);
    }
  });
});

describe("computeLabelMetrics", () => {
  it("多行標籤的 bottomHeight 隨行數增加", () => {
    const short = computeLabelMetrics("短", measure);
    const long = computeLabelMetrics("王顧採 Ch. 六埕順揚宮 主委代理人聯合會", measure);
    expect(long.lines.length).toBeGreaterThan(short.lines.length);
    expect(long.bottomHeight).toBeGreaterThan(short.bottomHeight);
    expect(short.bottomHeight).toBeGreaterThan(HEX_RADIUS + WORST_FONT);
  });

  it("halfWidth 不小於節點半徑", () => {
    const m = computeLabelMetrics("短", measure);
    expect(m.halfWidth).toBeGreaterThanOrEqual(HEX_RADIUS);
  });
});
