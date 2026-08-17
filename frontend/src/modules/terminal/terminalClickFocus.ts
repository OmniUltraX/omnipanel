import { getXterm } from "./xtermRegistry";

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
