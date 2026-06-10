import type { ContextMenuItem } from "./ContextMenu";

export type TabCloseAction = "close" | "closeLeft" | "closeRight" | "closeOthers" | "closeAll";

export type TabContextMenuAction = TabCloseAction | "rename";

type Translate = (key: string) => string;

export interface BuildTabCloseMenuOptions {
  /** 是否在关闭项之前显示「重命名」 */
  showRename?: boolean;
  /** 重命名菜单文案 i18n key，默认 shell.topbar.rename */
  renameLabelKey?: string;
}

/** 顶栏 / 工作区标签页通用的关闭类右键菜单项 */
export function buildTabCloseMenuItems(
  t: Translate,
  tabCount: number,
  tabIndex: number,
  onAction: (action: TabContextMenuAction) => void,
  options?: BuildTabCloseMenuOptions,
): ContextMenuItem[] {
  const renameItem: ContextMenuItem[] = options?.showRename
    ? [
        {
          id: "tab-rename",
          label: t(options.renameLabelKey ?? "shell.topbar.rename"),
          onClick: () => onAction("rename"),
        },
        { id: "tab-sep-rename", separator: true, label: "" },
      ]
    : [];

  return [
    ...renameItem,
    {
      id: "tab-close",
      label: t("shell.topbar.closeCurrent"),
      onClick: () => onAction("close"),
    },
    { id: "tab-sep-1", separator: true, label: "" },
    {
      id: "tab-close-left",
      label: t("shell.topbar.closeLeft"),
      disabled: tabIndex <= 0,
      onClick: () => onAction("closeLeft"),
    },
    {
      id: "tab-close-right",
      label: t("shell.topbar.closeRight"),
      disabled: tabIndex >= tabCount - 1,
      onClick: () => onAction("closeRight"),
    },
    { id: "tab-sep-2", separator: true, label: "" },
    {
      id: "tab-close-others",
      label: t("shell.topbar.closeOthers"),
      disabled: tabCount <= 1,
      onClick: () => onAction("closeOthers"),
    },
    {
      id: "tab-close-all",
      label: t("shell.topbar.closeAll"),
      disabled: tabCount <= 0,
      onClick: () => onAction("closeAll"),
    },
  ];
}
