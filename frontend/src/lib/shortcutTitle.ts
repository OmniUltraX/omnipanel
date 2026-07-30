import { formatShortcutList, getShortcutKeys } from "../stores/shortcutsStore";

/** 把操作名与当前生效快捷键拼成按钮 title，如「搜索终端 (Ctrl+F)」 */
export function shortcutTitle(label: string, shortcutId: string): string {
  const keys = getShortcutKeys(shortcutId);
  if (keys.length === 0) return label;
  const formatted = formatShortcutList(keys);
  return formatted ? `${label} (${formatted})` : label;
}
