import type { ActionDraft } from "../../stores/actionDraftStore";
import { useAiStore } from "../../stores/aiStore";
import { useSettingsStore } from "../../stores/settingsStore";

/**
 * AI 侧栏/抽屉是否对用户可见。
 * dockview / 弹窗模式均以 drawerOpen 为准（与 WorkspaceShell 一致）。
 */
export function isAiAssistantSurfaceOpen(): boolean {
  void useSettingsStore.getState().aiDisplayMode;
  return useAiStore.getState().drawerOpen;
}

/**
 * 终端内联审批走 blocksStore + TerminalToolCallDock，不经过统一队列。
 * 统一队列项若按「当前在终端页」分流，侧栏发起的审批会被误判为「已有终端 dock」
 * 而既不进 AiApprovalDock、也不进全局弹窗，导致 AI 永久等待确认。
 */
export function shouldPresentInTerminalDock(_draft: ActionDraft): boolean {
  return false;
}

/** 侧栏内嵌条：AI 面板打开时展示全部统一队列项 */
export function shouldPresentInAiDock(_draft: ActionDraft): boolean {
  return isAiAssistantSurfaceOpen();
}

/** 全局弹窗：AI 面板未打开时展示 */
export function shouldPresentInGlobalDialog(_draft: ActionDraft): boolean {
  return !isAiAssistantSurfaceOpen();
}

export function filterAiDockDrafts(drafts: ActionDraft[]): ActionDraft[] {
  // AiApprovalDock 挂在 Thread 内，能渲染即表示 AI 面可见；直接展示全部待确认
  return drafts;
}

export function filterGlobalDialogDrafts(drafts: ActionDraft[]): ActionDraft[] {
  if (isAiAssistantSurfaceOpen()) return [];
  return drafts;
}
