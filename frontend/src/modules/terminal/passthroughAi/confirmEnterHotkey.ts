import { canApprovePendingWithEnter } from "./decidePassthroughEnter";

function isXtermHelperTextarea(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && el.classList.contains("xterm-helper-textarea");
}

/** 真正在打字的表单控件；xterm 隐式 textarea 不算 */
export function isConfirmEnterTypingField(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (isXtermHelperTextarea(el)) return false;
  if (el.classList.contains("term-shell-agent-card__edit")) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return true;
  return el.isContentEditable;
}

function isForeignChromeControl(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (isXtermHelperTextarea(el)) return false;
  if (el.closest(".term-shell-agent-card--cmd")) return false;
  if (el.closest(".term-pane")) return false;
  return Boolean(
    el.closest(
      "button, a, [role='button'], [role='menuitem'], [role='dialog'], input, textarea, select",
    ),
  );
}

function paneForSession(sessionId: string): Element | null {
  return document.querySelector(`.term-pane[data-pane-id="${CSS.escape(sessionId)}"]`);
}

/**
 * 确认卡回车是否应由该会话处理。
 * 不要求 xterm textarea 有焦点：点过卡片/面板后焦点常在 .terminal-area。
 */
export function shouldHandleConfirmEnter(sessionId: string, e: KeyboardEvent): boolean {
  if (e.key !== "Enter" || e.repeat) return false;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return false;
  if (e.isComposing || e.keyCode === 229) return false;
  if (isConfirmEnterTypingField(e.target) || isConfirmEnterTypingField(document.activeElement)) {
    return false;
  }
  if (
    e.target instanceof HTMLElement &&
    e.target.closest(".term-shell-agent-btn") &&
    !e.target.closest(".term-shell-agent-btn--primary") &&
    !e.target.closest(".term-shell-agent-btn--danger")
  ) {
    return false;
  }
  if (!canApprovePendingWithEnter(sessionId)) return false;

  const pane = paneForSession(sessionId);
  const targetNode = e.target instanceof Node ? e.target : null;
  const active = document.activeElement;

  // 焦点/事件在侧栏、对话框等控件上：不抢（keydown 的 target 即焦点元素）
  if (isForeignChromeControl(e.target) && !(pane && targetNode && pane.contains(targetNode))) {
    return false;
  }

  if (pane) {
    if (targetNode && pane.contains(targetNode)) return true;
    if (active && pane.contains(active)) return true;
    if (isForeignChromeControl(active)) return false;
    return pane.classList.contains("is-active");
  }
  return !isForeignChromeControl(active);
}
