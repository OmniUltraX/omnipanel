/** 注入到所有 ContextMenu 末尾的「分享」项 id，避免重复追加。 */
export const GLOBAL_SHARE_MENU_ID = "__global-share";
export const GLOBAL_SHARE_SEP_ID = "__global-share-sep";

export type GlobalShareMenuItemBase = {
  id: string;
  label: string;
  onClick?: () => void;
  separator?: boolean;
};

/**
 * 在右键菜单末尾追加分隔线 +「分享」。
 * 若已含同 id 项则原样返回；空菜单则只加分享项。
 */
export function withGlobalShareMenuItem<T extends GlobalShareMenuItemBase>(
  items: T[],
  share: { label: string; onClick: () => void },
): T[] {
  if (items.some((item) => item.id === GLOBAL_SHARE_MENU_ID)) {
    return items;
  }
  const shareItem = {
    id: GLOBAL_SHARE_MENU_ID,
    label: share.label,
    onClick: share.onClick,
  } as T;
  if (items.length === 0) {
    return [shareItem];
  }
  const last = items[items.length - 1];
  if (last?.separator) {
    return [...items, shareItem];
  }
  const sep = {
    id: GLOBAL_SHARE_SEP_ID,
    label: "",
    separator: true,
  } as T;
  return [...items, sep, shareItem];
}
