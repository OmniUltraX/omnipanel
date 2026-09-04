import type { ContextMenuItem } from "../components/ui/menu/ContextMenu";
import { getHostSelection } from "./hostSelection";
import {
  GLOBAL_SHARE_MENU_ID,
  GLOBAL_SHARE_SEP_ID,
} from "../components/ui/menu/withGlobalShareMenuItem";

export type MenuWhen = {
  hasSelection?: boolean;
};

export type MenuContribution = {
  pluginId: string;
  id: string;
  label: string;
  when?: MenuWhen;
  /**
   * 悬浮按钮 opt-in：非空时，该动作同时出现在选中悬浮按钮上。
   * `icon` 为 1 字图标（如 "译"），缺省取 label 首字。
   */
  float?: { icon?: string };
  onClick: (ctx: { selectionText: string }) => void | Promise<void>;
};

const contributions: MenuContribution[] = [];

export function registerMenuContribution(item: MenuContribution): void {
  const idx = contributions.findIndex((c) => c.id === item.id);
  if (idx >= 0) contributions[idx] = item;
  else contributions.push(item);
}

/** deactivate 时按 pluginId 卸除登记。 */
export function unregisterMenuContributions(pluginId: string): void {
  for (let i = contributions.length - 1; i >= 0; i -= 1) {
    if (contributions[i].pluginId === pluginId) contributions.splice(i, 1);
  }
}

/** 第三方 host.ui.menu.unregister：按 pluginId + id 精确卸除，避免跨插件 id 碰撞。 */
export function unregisterMenuContributionById(pluginId: string, id: string): void {
  for (let i = contributions.length - 1; i >= 0; i -= 1) {
    if (contributions[i].pluginId === pluginId && contributions[i].id === id) {
      contributions.splice(i, 1);
    }
  }
}

export function visibleMenuContributions(): MenuContribution[] {
  const selection = getHostSelection();
  const hasSelection = Boolean(selection?.text);
  return contributions.filter((item) => {
    if (item.when?.hasSelection && !hasSelection) return false;
    return true;
  });
}

export type FloatContribution = MenuContribution & { selectionText: string };

/**
 * 选中悬浮按钮候选：仅 opt-in（`float` 非空）且有非空选区的动作。
 * 内核分享项（无 float 声明）不会出现，避免打扰日常选中。
 */
export function visibleFloatContributions(): FloatContribution[] {
  const selection = getHostSelection();
  const text = selection?.text ?? "";
  if (!text) return [];
  return contributions
    .filter((item) => item.float && (!item.when?.hasSelection || Boolean(text)))
    .map((item) => ({ ...item, selectionText: text }));
}

/**
 * 内核分享 addon：登记到贡献表末尾，与其它贡献一起泛化合并。
 * share 的 label/onClick 由调用方按当前选区注入（每次渲染绑定）。
 */
export function mergeContributedMenuItems(
  items: ContextMenuItem[],
  share: { label: string; onClick: () => void },
): ContextMenuItem[] {
  registerMenuContribution({
    pluginId: "omni.addon.share",
    id: GLOBAL_SHARE_MENU_ID,
    label: share.label,
    onClick: () => share.onClick(),
  });
  const extras = visibleMenuContributions().map((c) => ({
    id: c.id,
    label: c.label,
    onClick: () => c.onClick({ selectionText: getHostSelection()?.text ?? "" }),
  }));
  if (items.some((item) => item.id === GLOBAL_SHARE_MENU_ID)) {
    return items;
  }
  if (extras.length === 0) return items;
  if (items.length === 0) return extras;
  const last = items[items.length - 1];
  if (last?.separator) return [...items, ...extras];
  return [
    ...items,
    { id: GLOBAL_SHARE_SEP_ID, label: "", separator: true },
    ...extras,
  ];
}
