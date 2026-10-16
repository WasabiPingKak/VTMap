import { describe, expect, it } from "vitest";
import { renderTemplatePreview, roleDisplayText } from "./discordTemplate";

const CONTEXT = { title: "新影片", url: "https://y.tb/x", channel: "冰角", type: "影片" };

describe("renderTemplatePreview", () => {
  it("替換所有變數", () => {
    expect(renderTemplatePreview("{role} {channel}：{title} {url}（{type}）", "@粉絲", CONTEXT)).toBe(
      "@粉絲 冰角：新影片 https://y.tb/x（影片）",
    );
  });

  it("沒有 tag 時移除開頭空白", () => {
    expect(renderTemplatePreview("{role} {channel} 開台了", "", CONTEXT)).toBe("冰角 開台了");
  });

  it("模板沒有 {role} 但有 tag 時放在開頭", () => {
    expect(renderTemplatePreview("{title}", "@粉絲", CONTEXT)).toBe("@粉絲 新影片");
  });

  it("標題裡的大括號文字不會被再次替換", () => {
    expect(renderTemplatePreview("{title}", "", { ...CONTEXT, title: "{url}" })).toBe("{url}");
  });
});

describe("roleDisplayText", () => {
  const roles = [{ id: "7", name: "粉絲" }];

  it("未設定時為空字串", () => {
    expect(roleDisplayText(null, "1", roles)).toBe("");
  });

  it("伺服器 id 代表 @everyone", () => {
    expect(roleDisplayText("1", "1", roles)).toBe("@everyone");
  });

  it("顯示身分組名稱", () => {
    expect(roleDisplayText("7", "1", roles)).toBe("@粉絲");
  });
});
