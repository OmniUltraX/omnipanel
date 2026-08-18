import { useCallback, useEffect, type RefObject } from "react";

import { showToast } from "../../stores/toastStore";
import { getXterm } from "./xtermRegistry";

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

function isXtermHelperTextarea(el: Element): boolean {
  return el.classList.contains("xterm-helper-textarea") || Boolean(el.closest(".xterm-helper-textarea"));
}

/**
 * 左键点终端页面空白/卡片后应拉回输入焦点。
 * 按钮、表单、菜单、待确认卡等需要自己的焦点，不抢。
 */
export function shouldFocusTerminalOnClick(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  if (isXtermHelperTextarea(target)) return true;

  const typingField = target.closest("textarea, input, select, [contenteditable='true']");
  if (typingField && !isXtermHelperTextarea(typingField)) return false;

  if (
    target.closest(
      "button, a, [role='menuitem'], [role='menu'], [role='dialog'], [role='listbox'], [role='tab']",
    )
  ) {
    return false;
  }

  if (target.closest(".term-shell-agent-float")) return false;
  if (target.closest(".term-shell-agent-card--ask")) return false;
  if (target.closest(".term-shell-agent-card--cmd.is-pending, .term-shell-agent-card--cmd.is-danger")) {
    return false;
  }
  if (target.closest(".sidebar-tree-node, .tree-node")) return false;
  return true;
}

/** 命令栏可见则聚焦命令输入，否则聚焦 xterm 光标 */
export function focusTerminalPaneInput(sessionId: string): void {
  const pane = document.querySelector(`.term-pane[data-pane-id="${CSS.escape(sessionId)}"]`);
  const cmd = pane?.querySelector<HTMLTextAreaElement>("textarea.term-cmd-textarea");
  if (cmd && cmd.offsetParent !== null) {
    cmd.focus({ preventScroll: true });
    return;
  }
  getXterm(sessionId)?.focus();
}
