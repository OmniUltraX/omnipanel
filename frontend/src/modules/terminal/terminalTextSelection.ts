import { useCallback, useEffect, type RefObject } from "react";

import { showToast } from "../../stores/toastStore";

export function getDomSelectionTextWithin(root: HTMLElement | null): string {
  if (!root) return "";
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return "";
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return "";
  return selection.toString();
}

export function hasDomTextSelection(): boolean {
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim());
}

export function isSimplePointerClick(
  from: { x: number; y: number },
  to: { x: number; y: number },
  thresholdPx = 4,
): boolean {
  const dx = from.x - to.x;
  const dy = from.y - to.y;
  const limit = thresholdPx * thresholdPx;
  return dx * dx + dy * dy <= limit;
}

export function clearDomSelection(): void {
  window.getSelection()?.removeAllRanges();
}

export async function copyTerminalText(text: string): Promise<boolean> {
  const value = text.replace(/\r\n/g, "\n");
  if (!value.trim()) return false;
  try {
    await navigator.clipboard.writeText(value);
    showToast("已复制");
    return true;
  } catch {
    showToast("复制失败");
    return false;
  }
}

export type XtermSelectionBridge = {
  hasSelection: () => boolean;
  getSelection: () => string;
  clearSelection: () => void;
};

/** 有选区时右键复制并清除选区；返回 true 表示已处理。 */
export async function copyTerminalSelectionOnContextMenu(
  event: MouseEvent,
  root: HTMLElement | null,
  xterm?: XtermSelectionBridge | null,
): Promise<boolean> {
  if (xterm?.hasSelection()) {
    const text = xterm.getSelection();
    if (!text.trim()) return false;
    event.preventDefault();
    event.stopPropagation();
    const copied = await copyTerminalText(text);
    if (copied) {
      xterm.clearSelection();
      clearDomSelection();
    }
    return copied;
  }

  const domText = getDomSelectionTextWithin(root);
  if (!domText.trim()) return false;

  event.preventDefault();
  event.stopPropagation();
  const copied = await copyTerminalText(domText);
  if (copied) clearDomSelection();
  return copied;
}

export function useTerminalCopyContextMenu(
  rootRef: RefObject<HTMLElement | null>,
  xtermRef?: RefObject<XtermSelectionBridge | null>,
): void {
  const onContextMenu = useCallback(
    (event: MouseEvent) => {
      void copyTerminalSelectionOnContextMenu(
        event,
        rootRef.current,
        xtermRef?.current ?? null,
      );
    },
    [rootRef, xtermRef],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.addEventListener("contextmenu", onContextMenu);
    return () => root.removeEventListener("contextmenu", onContextMenu);
  }, [onContextMenu, rootRef]);
}
