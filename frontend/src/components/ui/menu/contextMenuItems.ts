import type { ContextMenuItem } from "./ContextMenu";
import type { WorkspaceInfo } from "../../../stores/workspaceStore";

export type TabCloseAction = "close" | "closeLeft" | "closeRight" | "closeOthers" | "closeAll";

export type TabContextMenuAction = TabCloseAction | "rename" | "aiRename" | "refresh";

type Translate = (key: string) => string;

export interface BuildTabCloseMenuOptions {
  /** 是否在关闭项之前显示「重命名」 */
  showRename?: boolean;
  /** 重命名菜单文案 i18n key，默认 shell.topbar.rename */
  renameLabelKey?: string;
  /** 是否显示「AI 重新命名」菜单项 */
  showAiRename?: boolean;
  /** AI 重新命名菜单文案 i18n key，默认 terminal.sessions.aiRename */
  aiRenameLabelKey?: string;
  /** 是否显示移动到工作区相关菜单项 */
  showWorkspaceActions?: boolean;
  /** 当前工作区 ID（showWorkspaceActions 时必填） */
  currentWorkspaceId?: string;
  /** 全部工作区列表，用于「移动到其他工作区」子菜单 */
  workspaces?: WorkspaceInfo[];
  /** 将 Tab 移动到指定工作区 */
  onMoveToWorkspace?: (workspaceId: string) => void;
  /** 是否显示刷新菜单项 */
  showRefresh?: boolean;
  /**
   * 关闭相关菜单布局：
   * - default：关闭当前 + 分隔 + 左/右/其他/全部（平铺）
   * - submenu：仅「关闭标签」子菜单（左/右/其他/全部）
   * - none：不输出关闭项（由调用方自定义）
   */
  closeMenuMode?: "default" | "submenu" | "none";
}

function buildWorkspaceTabMenuItems(
  t: Translate,
  options: Pick<
    BuildTabCloseMenuOptions,
    "showWorkspaceActions" | "currentWorkspaceId" | "workspaces" | "onMoveToWorkspace"
  >,
): ContextMenuItem[] {
  if (!options.showWorkspaceActions) return [];
  const currentId = options.currentWorkspaceId;
  const onMove = options.onMoveToWorkspace;
  if (!currentId || !onMove) return [];

  const others = (options.workspaces ?? []).filter((ws) => ws.id !== currentId);
  const otherChildren: ContextMenuItem[] =
    others.length > 0
      ? others.map((ws) => ({
          id: `tab-move-to-workspace-${ws.id}`,
          label: ws.name || ws.id,
          onClick: () => onMove(ws.id),
        }))
      : [
          {
            id: "tab-move-to-workspace-none",
            label: t("shell.workspace.noOther"),
            disabled: true,
            onClick: () => {},
          },
        ];

  return [
    {
      id: "tab-move-to-current-workspace",
      label: t("shell.workspace.moveToCurrent"),
      onClick: () => onMove(currentId),
    },
    {
      id: "tab-move-to-other-workspace",
      label: t("shell.workspace.moveToOther"),
      children: otherChildren,
    },
    { id: "tab-sep-workspace", separator: true, label: "" },
  ];
}

function buildTabBulkCloseSubmenuItems(
  t: Translate,
  tabCount: number,
  tabIndex: number,
  onAction: (action: TabCloseAction) => void,
): ContextMenuItem[] {
  return [
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

  const aiRenameItem: ContextMenuItem[] = options?.showAiRename
    ? [
        {
          id: "tab-ai-rename",
          label: t(options.aiRenameLabelKey ?? "terminal.sessions.aiRename"),
          onClick: () => onAction("aiRename"),
        },
        { id: "tab-sep-ai-rename", separator: true, label: "" },
      ]
    : [];

  const workspaceItems = buildWorkspaceTabMenuItems(t, options ?? {});

  const refreshItem: ContextMenuItem[] = options?.showRefresh
    ? [
        {
          id: "tab-refresh",
          label: t("shell.topbar.refresh"),
          onClick: () => onAction("refresh"),
        },
        { id: "tab-sep-refresh", separator: true, label: "" },
      ]
    : [];

  const closeMenuMode = options?.closeMenuMode ?? "default";
  const closeItems: ContextMenuItem[] = (() => {
    if (closeMenuMode === "none") return [];
    if (closeMenuMode === "submenu") {
      return [
        {
          id: "tab-close-bulk",
          label: t("shell.topbar.closeTabs"),
          children: buildTabBulkCloseSubmenuItems(t, tabCount, tabIndex, onAction),
        },
      ];
    }
    return [
      {
        id: "tab-close",
        label: t("shell.topbar.closeCurrent"),
        onClick: () => onAction("close"),
      },
      { id: "tab-sep-1", separator: true, label: "" },
      ...buildTabBulkCloseSubmenuItems(t, tabCount, tabIndex, onAction),
    ];
  })();

  return [
    ...renameItem,
    ...aiRenameItem,
    ...workspaceItems,
    ...refreshItem,
    ...closeItems,
  ];
}

export { buildWorkspaceTabMenuItems, buildTabBulkCloseSubmenuItems };
