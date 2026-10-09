/**
 * 侧栏 AI 要跑命令时，不再干等用户自己打开终端。
 * 跟随开：左侧打开对应终端（本地或 SSH）再执行。
 * 跟随关：挂到不占前台的后台终端上执行。
 */
import { findTerminalPane, useTerminalStore } from "../../stores/terminalStore";
import { resolveResourceById } from "../../stores/connectionStore";
import { LOCAL_TERMINAL_RESOURCE_ID, buildSessionInfoForResource } from "./paneResource";
import { terminalPaneSenders } from "./terminalPaneSenders";
import {
  focusTerminalTab,
  openLocalTerminalSession,
  openSshTerminalSession,
} from "../../lib/terminalSession";

export const AI_BACKGROUND_PURPOSE = "ai-background";

export function annotateTerminalSession(outputJson: string, tabId: string): string {
  try {
    const parsed = JSON.parse(outputJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return JSON.stringify({ ...parsed, terminalSessionId: tabId }, null, 2);
    }
  } catch {
    // 纯文本结果保持原样
  }
  return outputJson;
}

export async function waitForTerminalSender(tabId: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (terminalPaneSenders[tabId]) return true;
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  return Boolean(terminalPaneSenders[tabId]);
}

function backgroundTitle(resourceId: string): string {
  if (resourceId === LOCAL_TERMINAL_RESOURCE_ID) return "后台终端";
  return `后台 · ${resolveResourceById(resourceId)?.name ?? resourceId}`;
}

/** 不进左侧标签栏的会话，由 AiBackgroundTerminalHost 挂上输入通道。 */
export function ensureBackgroundTerminalTab(resourceId: string): string {
  const store = useTerminalStore.getState();
  const existing = store.tabs.find(
    (tab) =>
      tab.workspaceOnly &&
      tab.session.purpose === AI_BACKGROUND_PURPOSE &&
      tab.session.resourceId === resourceId,
  );
  if (existing) return existing.sessionId;

  const session = {
    ...buildSessionInfoForResource(resourceId),
    purpose: AI_BACKGROUND_PURPOSE,
  };
  const title = backgroundTitle(resourceId);
  const sessionId = store.createSession(title, session);
  return store.addTab({
    id: sessionId,
    sessionId,
    title,
    session,
    workspaceOnly: true,
  });
}

export async function ensureAiExecTerminal(options: {
  follow: boolean;
  sessionId?: string;
  sshResourceId?: string;
}): Promise<string> {
  const requested = options.sessionId?.trim() ?? "";
  const sshResourceId = options.sshResourceId?.trim() ?? "";

  if (requested && terminalPaneSenders[requested]) {
    if (options.follow) focusTerminalTab(requested);
    return requested;
  }

  if (sshResourceId) {
    return openExecTerminal(options.follow, sshResourceId, 15_000);
  }

  if (requested && options.follow && focusTerminalTab(requested)) {
    if (await waitForTerminalSender(requested, 8_000)) return requested;
  }

  // 跟随开才复用眼前这个终端；关掉时命令进后台，避免写进用户正在看的会话。
  if (!requested && options.follow) {
    const active = useTerminalStore.getState().activeTabId;
    if (active && terminalPaneSenders[active]) {
      focusTerminalTab(active);
      return active;
    }
  }

  const pane = requested ? findTerminalPane(requested) : undefined;
  const resourceId =
    pane?.type === "remote" ? pane.resourceId : LOCAL_TERMINAL_RESOURCE_ID;
  return openExecTerminal(options.follow, resourceId, resourceId === LOCAL_TERMINAL_RESOURCE_ID ? 8_000 : 15_000);
}

async function openExecTerminal(
  follow: boolean,
  resourceId: string,
  timeoutMs: number,
): Promise<string> {
  const local = resourceId === LOCAL_TERMINAL_RESOURCE_ID;
  let tabId: string | null;
  if (follow) {
    tabId = local ? openLocalTerminalSession() : openSshTerminalSession(resourceId);
    if (!tabId) {
      throw new Error(local ? "无法打开本地终端" : "找不到这台 SSH 主机，无法打开终端");
    }
  } else {
    tabId = ensureBackgroundTerminalTab(resourceId);
  }
  if (!(await waitForTerminalSender(tabId, timeoutMs))) {
    throw new Error(
      follow
        ? "终端尚未就绪"
        : local
          ? "后台终端尚未就绪"
          : "后台 SSH 终端尚未就绪",
    );
  }
  return tabId;
}
