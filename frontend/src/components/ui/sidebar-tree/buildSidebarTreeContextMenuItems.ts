import type { ContextMenuItem } from "@/components/ui/ContextMenu";

export type BuildSidebarTreeContextMenuItemsOptions = {
  renameLabel: string;
  deleteLabel: string;
  onRename?: () => void;
  onDelete?: () => void;
  renameDisabled?: boolean;
  deleteDisabled?: boolean;
  extraItems?: ContextMenuItem[];
};

/** 构建侧栏树节点默认右键菜单（重命名 / 删除 + 附加项）。 */
export function buildSidebarTreeContextMenuItems({
  renameLabel,
  deleteLabel,
  onRename,
  onDelete,
  renameDisabled,
  deleteDisabled,
  extraItems = [],
}: BuildSidebarTreeContextMenuItemsOptions): ContextMenuItem[] {
  const items: ContextMenuItem[] = [...extraItems];

  if (onRename) {
    items.push({
      id: "sidebar-tree-rename",
      label: renameLabel,
      disabled: renameDisabled,
      onClick: onRename,
    });
  }

  if (onDelete) {
    items.push({
      id: "sidebar-tree-delete",
      label: deleteLabel,
      danger: true,
      disabled: deleteDisabled,
      onClick: onDelete,
    });
  }

  return items;
}
