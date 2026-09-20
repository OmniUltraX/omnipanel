import { describe, expect, it } from "vitest";
import { buildModuleSidebarContextMenu } from "./buildModuleSidebarContextMenu";

const item = (id: string) => ({ id, label: id });

describe("buildModuleSidebarContextMenu", () => {
  it("空段跳过，分隔线只出现在非空段之间", () => {
    const items = buildModuleSidebarContextMenu({
      open: [item("open")],
      create: [],
      edit: [item("rename")],
      danger: [item("delete")],
    });
    expect(items.map((i) => ("separator" in i && i.separator ? "sep" : i.id))).toEqual([
      "open",
      "sep",
      "rename",
      "sep",
      "delete",
    ]);
  });

  it("全空返回空数组", () => {
    expect(buildModuleSidebarContextMenu({})).toEqual([]);
  });

  it("单段无分隔线", () => {
    const items = buildModuleSidebarContextMenu({ danger: [item("delete")] });
    expect(items).toHaveLength(1);
  });
});
