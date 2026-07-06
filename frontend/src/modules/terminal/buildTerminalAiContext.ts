import { getResourceById } from "../../lib/resourceRegistry";
import { useSshStatsStore } from "../../stores/sshStatsStore";
import { useTerminalStore } from "../../stores/terminalStore";
import type { TerminalSessionInfo } from "../../stores/terminalStore";
import type { WorkspaceResource } from "../../lib/resourceRegistry";
import type { HostSystemStats } from "../../ipc/bindings";
import {
  buildSessionMetaLine,
  inferShellLabel,
  parseSshSubtitle,
  resolveOsLabel,
} from "./terminalSessionDisplay";

/** AI 终端上下文提示行：告知模型必须按此 shell/OS 语法执行命令。 */
export const TERMINAL_CONTEXT_IMPORTANT_LINE =
  "- IMPORTANT: Commands run in THIS terminal session. Use shell syntax matching the OS/shell above (e.g. `date` on Linux/bash, `Get-Date` on Windows PowerShell only).";

/** 终端环境结构化提示——所有 AI 路径共享的单一真相源。 */
export interface AiTerminalHints {
  sessionType: TerminalSessionInfo["type"];
  /** SSH user@host:port 或本地资源名 */
  hostLine: string | null;
  workingDirectory: string | null;
  shell: string;
  os: string | null;
  /** shell · os · hardware 组合行 */
  environment: string | null;
}

/** 从 session/resource/stats 解析结构化终端提示。 */
export function resolveAiTerminalHints(
  session: TerminalSessionInfo,
  resource: WorkspaceResource | null,
  stats: HostSystemStats | null,
): AiTerminalHints {
  const shell = inferShellLabel(session, resource);
  const os = resolveOsLabel(resource, stats);
  const meta = buildSessionMetaLine(session, resource, stats);
  const ssh = parseSshSubtitle(resource?.subtitle);

  let hostLine: string | null = null;
  if (ssh.user || ssh.host) {
    const host = [ssh.user, ssh.host].filter(Boolean).join("@");
    const port = ssh.port ? `:${ssh.port}` : "";
    hostLine = `${host}${port}`;
  } else if (resource?.name) {
    hostLine = resource.name;
  }

  return {
    sessionType: session.type,
    hostLine,
    workingDirectory: session.cwd?.trim() || null,
    shell,
    os,
    environment: meta && meta !== shell ? meta : null,
  };
}

/** 将结构化 hints 格式化为 prompt 文本块。 */
export function formatAiTerminalHints(hints: AiTerminalHints): string {
  const lines = ["[Terminal Context]"];
  lines.push(`- Session type: ${hints.sessionType}`);
  if (hints.hostLine) {
    lines.push(`- Host: ${hints.hostLine}`);
  }
  if (hints.workingDirectory) {
    lines.push(`- Working directory: ${hints.workingDirectory}`);
  }
  lines.push(`- Shell: ${hints.shell}`);
  if (hints.os) lines.push(`- OS: ${hints.os}`);
  if (hints.environment) {
    lines.push(`- Environment: ${hints.environment}`);
  }
  lines.push(TERMINAL_CONTEXT_IMPORTANT_LINE);
  return lines.join("\n");
}

/**
 * 为 ACP client-tools prompt 构建终端环境上下文块。
 * 所有需要终端上下文的 AI 路径统一调用此函数。
 */
export function buildTerminalAiContextAppend(sessionId: string): string | null {
  const tab = useTerminalStore.getState().tabs.find((t) => t.id === sessionId);
  if (!tab) return null;

  const session = tab.session;
  const resource = getResourceById(session.resourceId);
  const stats = useSshStatsStore.getState().statsMap[session.resourceId] ?? null;

  const hints = resolveAiTerminalHints(session, resource, stats);
  return formatAiTerminalHints(hints);
}
