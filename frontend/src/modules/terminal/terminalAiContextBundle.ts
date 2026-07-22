import type { TerminalSessionInfo } from "../../stores/terminalStore";
import type { WorkspaceResource } from "../../lib/resourceRegistry";
import { useSshStatsStore } from "../../stores/sshStatsStore";
import { findTerminalPane } from "../../stores/terminalStore";
import { resolveResourceById } from "../../stores/connectionStore";
import type { HostSystemStats } from "../../ipc/bindings";
import type { AiContextBundle } from "../../lib/ai/orchestrator";
import {
  formatAiTerminalHints,
  resolveAiTerminalHints,
  TERMINAL_CONTEXT_IMPORTANT_LINE,
} from "./buildTerminalAiContext";

export type TerminalConversationScope = "assistant" | "terminal-inline";

/** 终端 AI 上下文统一 bundle：隔离远程 cwd、本地 Agent cwd 与工具目标 session。 */
export interface TerminalAiContextBundle {
  terminalSessionId: string;
  terminalResourceId: string | null;
  terminalSessionType: TerminalSessionInfo["type"];
  remoteWorkingDirectory: string | null;
  localAgentCwd: string | null;
  terminalContextAppend: string | null;
  conversationScope: TerminalConversationScope;
}

export function resolveInlineConversationId(sessionId: string): string {
  return `term-inline:${sessionId}`;
}

export function resolveTerminalAiContextBundle(
  sessionId: string,
  scope: TerminalConversationScope = "assistant",
): TerminalAiContextBundle | null {
  const pane = findTerminalPane(sessionId);
  if (!pane) return null;

  const session: TerminalSessionInfo = {
    type: pane.type,
    resourceId: pane.resourceId,
    shellLabel: pane.shellLabel,
    cwd: pane.cwd,
    purpose: pane.purpose,
    commandPack: pane.commandPack,
  };
  const resource = resolveResourceById(session.resourceId);
  const stats = useSshStatsStore.getState().statsMap[session.resourceId] ?? null;
  const isRemote = session.type === "remote";
  const remoteCwd = session.cwd?.trim() || null;

  let terminalContextAppend = buildTerminalContextAppend(session, resource, stats);
  if (isRemote) {
    terminalContextAppend = appendLocalAgentRuntimeNote(terminalContextAppend);
  }

  return {
    terminalSessionId: sessionId,
    terminalResourceId: session.resourceId ?? null,
    terminalSessionType: session.type,
    remoteWorkingDirectory: isRemote ? remoteCwd : null,
    localAgentCwd: isRemote ? null : remoteCwd,
    terminalContextAppend,
    conversationScope: scope,
  };
}

function buildTerminalContextAppend(
  session: TerminalSessionInfo,
  resource: WorkspaceResource | null,
  stats: HostSystemStats | null,
): string {
  const hints = resolveAiTerminalHints(session, resource, stats);
  return formatAiTerminalHints(hints);
}

function appendLocalAgentRuntimeNote(append: string | null): string {
  const note =
    "- [Local Agent Runtime] The coding agent process runs on your local machine. Its filesystem cwd is NOT the remote terminal working directory. Execute shell commands only via the terminal tool bound to this session.";
  if (!append?.trim()) {
    return `[Terminal Context]\n${note}\n${TERMINAL_CONTEXT_IMPORTANT_LINE}`;
  }
  if (append.includes("[Local Agent Runtime]")) return append;
  return `${append}\n${note}`;
}

export function terminalAiBundleToOrchestratorContext(
  bundle: TerminalAiContextBundle,
): AiContextBundle {
  return {
    cwd: bundle.localAgentCwd,
    workspaceId: null,
    terminalSessionId: bundle.terminalSessionId,
    terminalSessionType: bundle.terminalSessionType,
    envTag: null,
    resourceId: bundle.terminalResourceId,
    terminalContextAppend: bundle.terminalContextAppend,
  };
}
