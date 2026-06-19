import { useEffect } from "react";
import { useWorkspacePreviewCollapseStore } from "../stores/workspacePreviewCollapseStore";
import { getShortcutKeys, matchesShortcut } from "../stores/shortcutsStore";

export function isBottomWorkspaceShortcut(e: KeyboardEvent): boolean {
  if (e.type !== "keydown") return false;
  return matchesShortcut(e, getShortcutKeys("toggle-bottom-workspace"));
}

/** 处理 Alt/Option+W，返回是否已消费该按键 */
export function triggerBottomWorkspaceToggle(e: KeyboardEvent): boolean {
  if (!isBottomWorkspaceShortcut(e)) return false;
  e.preventDefault();
  e.stopPropagation();
  useWorkspacePreviewCollapseStore.getState().toggle();
  return true;
}

/** 全局 Alt/Option+W 展开/隐藏 WorkspacePreview 预览栏（捕获阶段） */
export function useBottomWorkspaceShortcut() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      triggerBottomWorkspaceToggle(e);
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, []);
}
