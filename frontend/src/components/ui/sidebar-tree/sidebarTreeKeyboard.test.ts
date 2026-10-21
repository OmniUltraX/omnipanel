import { describe, expect, it } from "vitest";
import {
  resolveSidebarTreeKeyAction,
  type SidebarTreeKeyEvent,
  type SidebarTreeKeyNode,
  type SidebarTreeKeyState,
} from "./sidebarTreeKeyboard";

function node(partial: Partial<SidebarTreeKeyNode> & Pick<SidebarTreeKeyNode, "key" | "depth">): SidebarTreeKeyNode {
  return {
    hasChildren: false,
    expanded: false,
    canRename: false,
    canDelete: true,
    canActivate: true,
    canToggle: false,
    canRefresh: false,
    ...partial,
  };
}

function press(key: string, extra: Partial<SidebarTreeKeyEvent> = {}): SidebarTreeKeyEvent {
  return { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, ...extra };
}

const tree: SidebarTreeKeyNode[] = [
  node({ key: "folder", depth: 0, hasChildren: true, expanded: true, canToggle: true, canRename: true }),
  node({ key: "host-a", depth: 1, canRename: true }),
  node({ key: "host-b", depth: 1, canRename: true }),
];

const focused: SidebarTreeKeyState = {
  selectedIds: new Set(["host-a"]),
  anchorId: "host-a",
  focusId: "host-a",
};

describe("resolveSidebarTreeKeyAction", () => {
  it("上下方向键移动单选", () => {
    const down = resolveSidebarTreeKeyAction(press("ArrowDown"), focused, tree);
    expect(down).toMatchObject({ type: "selection", selectedIds: ["host-b"], focusId: "host-b" });
    const up = resolveSidebarTreeKeyAction(press("ArrowUp"), focused, tree);
    expect(up).toMatchObject({ type: "selection", selectedIds: ["folder"], focusId: "folder" });
  });

  it("Shift 方向键从锚点扩展选区，Ctrl 方向键只移动焦点", () => {
    const range = resolveSidebarTreeKeyAction(press("ArrowDown", { shiftKey: true }), focused, tree);
    expect(range).toMatchObject({
      type: "selection",
      selectedIds: ["host-a", "host-b"],
      anchorId: "host-a",
      focusId: "host-b",
    });
    const move = resolveSidebarTreeKeyAction(press("ArrowDown", { ctrlKey: true }), focused, tree);
    expect(move).toMatchObject({
      type: "selection",
      selectedIds: ["host-a"],
      focusId: "host-b",
    });
  });

  it("左右方向键展开折叠，折叠后再向左回到父节点", () => {
    const collapse = resolveSidebarTreeKeyAction(
      press("ArrowLeft"),
      { selectedIds: new Set(["folder"]), anchorId: "folder", focusId: "folder" },
      tree,
    );
    expect(collapse).toEqual({ type: "toggle", key: "folder" });

    const collapsed = tree.map((item) => (item.key === "folder" ? { ...item, expanded: false } : item));
    const expand = resolveSidebarTreeKeyAction(
      press("ArrowRight"),
      { selectedIds: new Set(["folder"]), anchorId: "folder", focusId: "folder" },
      collapsed,
    );
    expect(expand).toEqual({ type: "toggle", key: "folder" });

    const parent = resolveSidebarTreeKeyAction(press("ArrowLeft"), focused, [
      { ...tree[0]!, expanded: false },
      tree[1]!,
      tree[2]!,
    ]);
    expect(parent).toMatchObject({ type: "selection", focusId: "folder" });
  });

  it("Home / End / Ctrl+A / Escape", () => {
    expect(resolveSidebarTreeKeyAction(press("Home"), focused, tree)).toMatchObject({ focusId: "folder" });
    expect(resolveSidebarTreeKeyAction(press("End"), focused, tree)).toMatchObject({ focusId: "host-b" });
    expect(resolveSidebarTreeKeyAction(press("a", { ctrlKey: true }), focused, tree)).toMatchObject({
      selectedIds: ["folder", "host-a", "host-b"],
    });
    const escape = resolveSidebarTreeKeyAction(press("Escape"), {
      selectedIds: new Set(["folder", "host-a"]),
      anchorId: "folder",
      focusId: "host-a",
    }, tree);
    expect(escape).toMatchObject({ selectedIds: ["host-a"], focusId: "host-a" });
  });

  it("F2 只重命名当前一个，Delete 在多选里删整组，Enter 打开", () => {
    expect(resolveSidebarTreeKeyAction(press("F2"), focused, tree)).toEqual({ type: "rename", key: "host-a" });
    expect(
      resolveSidebarTreeKeyAction(press("F2"), {
        selectedIds: new Set(["host-a", "host-b"]),
        anchorId: "host-a",
        focusId: "host-a",
      }, tree),
    ).toBeNull();
    expect(
      resolveSidebarTreeKeyAction(press("Delete"), {
        selectedIds: new Set(["host-a", "host-b"]),
        anchorId: "host-a",
        focusId: "host-a",
      }, tree),
    ).toEqual({ type: "delete", keys: ["host-a", "host-b"] });
    expect(resolveSidebarTreeKeyAction(press("Enter"), focused, tree)).toEqual({ type: "activate", key: "host-a" });
  });

  it("Ctrl+Space 切换当前项的选中", () => {
    const toggled = resolveSidebarTreeKeyAction(press(" ", { ctrlKey: true }), focused, tree);
    expect(toggled).toMatchObject({ selectedIds: [], focusId: "host-a" });
  });
});
