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
  onClick: (ctx: { selectionText: string }) => void;
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

export function visibleMenuContributions(): MenuContribution[] {
  const selection = getHostSelection();
  const hasSelection = Boolean(selection?.text);
  return contributions.filter((item) => {
    if (item.when?.hasSelection && !hasSelection) return false;
    return true;
  });
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
