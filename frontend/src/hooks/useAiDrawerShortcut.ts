import { useEffect } from "react";
import { useAiStore } from "../stores/aiStore";
import { getShortcutKeys, matchesShortcut } from "../stores/shortcutsStore";

export function isAiDrawerShortcut(e: KeyboardEvent): boolean {
  if (e.type !== "keydown") return false;
  return matchesShortcut(e, getShortcutKeys("toggle-ai"));
}

/** 处理 Alt/Option+`，返回是否已消费该按键 */
export function triggerAiDrawerToggle(e: KeyboardEvent): boolean {
  if (!isAiDrawerShortcut(e)) return false;
  e.preventDefault();
  e.stopPropagation();
  useAiStore.getState().toggleDrawer();
  return true;
}

/** 全局 Alt/Option+` 切换 AI 子窗口（捕获阶段，优先于 xterm 等） */
export function useAiDrawerShortcut() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      triggerAiDrawerToggle(e);
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, []);
}
