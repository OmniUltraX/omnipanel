import { setTerminalPaneSender, terminalPaneSenders } from "../terminalPaneSenders";
import { findTerminalPane } from "../../../stores/terminalStore";
import { resolveTerminalShellFamily } from "../terminalAutoLsShell";
import { useSessionShellHistoryStore } from "./sessionShellHistoryStore";
import { fetchShellHistoryForSession, ptyHistorySyncedBackendIds, resolveBackendSessionId } from "./shellHistoryFetch";

/** 文本同步标记（PTY 回显解析备用） */
export const SHELL_HISTORY_SYNC_BEGIN = "__OMNIPANEL_HIST_BEGIN__";
export const SHELL_HISTORY_SYNC_END = "__OMNIPANEL_HIST_END__";

/** 兼容旧别名触发 */
export const SHELL_HISTORY_SYNC_ALIAS = "__omnipanel_history_sync__";

/** 从 HISTFILE 同步的最大行数 */
export const SHELL_HISTORY_SYNC_MAX = 5000;

export const SHELL_HISTORY_SYNC_COMMAND = [
  `printf '${SHELL_HISTORY_SYNC_BEGIN}\\n'`,
  'f="${HISTFILE:-$HOME/.bash_history}"',
  `if [ -f "$f" ]; then tail -n ${SHELL_HISTORY_SYNC_MAX} "$f" | base64 -w0 2>/dev/null || tail -n ${SHELL_HISTORY_SYNC_MAX} "$f" | base64 | tr -d '\\n'; fi`,
  `printf '\\n${SHELL_HISTORY_SYNC_END}\\n'`,
].join("; ");

/** Windows PowerShell：读取 PSReadLine 历史文件（与 bash 同步共用 BEGIN/END 标记） */
export const SHELL_HISTORY_SYNC_COMMAND_POWERSHELL = [
  `Write-Output '${SHELL_HISTORY_SYNC_BEGIN}'`,
  "try { $f=(Get-PSReadLineOption).HistorySavePath",
  `if ($f -and (Test-Path -LiteralPath $f)) { $t=Get-Content -LiteralPath $f -Tail ${SHELL_HISTORY_SYNC_MAX} -Raw; if ($t) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t)) } }`,
  "} catch {}",
  `Write-Output '${SHELL_HISTORY_SYNC_END}'`,
].join("; ");

/** 按会话 shell 类型选择 PTY 历史同步命令；不支持时返回 null（如 cmd）。 */
export function resolveShellHistorySyncCommand(sessionId: string): string | null {
  const pane = findTerminalPane(sessionId);
  if (!pane) return null;
  const shell = resolveTerminalShellFamily(pane.type, pane.shellLabel);
  if (shell === "posix") return SHELL_HISTORY_SYNC_COMMAND;
  if (shell === "powershell") return SHELL_HISTORY_SYNC_COMMAND_POWERSHELL;
  return null;
}

const SYNC_THROTTLE_MS = 30_000;
const SYNC_TIMEOUT_MS = 25_000;

const syncingSessions = new Set<string>();

export function isSilentHistorySyncCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (trimmed === SHELL_HISTORY_SYNC_ALIAS) return true;
  if (trimmed.includes(SHELL_HISTORY_SYNC_BEGIN)) return true;
  if (trimmed.includes(SHELL_HISTORY_SYNC_END)) return true;
  if (trimmed.includes("HistoryBlobEnd") || trimmed.includes("HistoryPart=")) return true;
  if (trimmed.includes("HISTFILE") && trimmed.includes("base64")) return true;
  if (trimmed.includes("Get-PSReadLineOption") && trimmed.includes(SHELL_HISTORY_SYNC_BEGIN)) return true;
  if (trimmed.includes("HistorySavePath") && trimmed.includes("ToBase64String")) return true;
  return false;
}

export function isSilentHistorySync(sessionId: string): boolean {
  return syncingSessions.has(sessionId);
}

export function beginSilentHistorySync(sessionId: string): void {
  syncingSessions.add(sessionId);
  window.setTimeout(() => {
    if (syncingSessions.has(sessionId)) {
      finishSilentHistorySync(sessionId);
    }
  }, SYNC_TIMEOUT_MS);
}

export function finishSilentHistorySync(sessionId: string): void {
  syncingSessions.delete(sessionId);
}

export function decodeShellHistoryOscPayload(encoded: string): string {
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return encoded;
  }
}

function requestShellHistorySyncViaPty(sessionId: string): void {
  const sender = terminalPaneSenders[sessionId];
  if (!sender || syncingSessions.has(sessionId)) return;

  const backendId = resolveBackendSessionId(sessionId);
  if (backendId && ptyHistorySyncedBackendIds.has(backendId)) return;

  const command = resolveShellHistorySyncCommand(sessionId);
  if (!command) return;

  beginSilentHistorySync(sessionId);
  sender(command);
  if (backendId) ptyHistorySyncedBackendIds.add(backendId);
}

/** 拉取 shell 历史：本地/远端优先直读历史文件，失败再走 PTY 静默同步 */
export function requestShellHistorySync(sessionId: string, options?: { force?: boolean }): void {
  if (!options?.force) {
    const backendId = resolveBackendSessionId(sessionId);
    if (backendId && ptyHistorySyncedBackendIds.has(backendId)) return;
  }

  const syncedAt = useSessionShellHistoryStore.getState().getSyncedAt(sessionId);
  const existingCount = useSessionShellHistoryStore.getState().getCommands(sessionId).length;
  if (
    !options?.force &&
    syncedAt > 0 &&
    Date.now() - syncedAt < SYNC_THROTTLE_MS &&
    existingCount >= 20
  ) {
    return;
  }

  void fetchShellHistoryForSession(sessionId).then((ok) => {
    if (!ok) {
      if (!resolveShellHistorySyncCommand(sessionId)) return;
      requestShellHistorySyncViaPty(sessionId);
    }
  });
}

/** 带重试的历史同步 */
export function requestShellHistorySyncWithRetry(
  sessionId: string,
  maxAttempts = 4,
  intervalMs = 1500,
): void {
  let attempt = 0;

  const run = () => {
    if (attempt >= maxAttempts) return;
    if (!resolveShellHistorySyncCommand(sessionId)) return;
    attempt += 1;

    const prev = useSessionShellHistoryStore.getState().getCommands(sessionId).length;
    requestShellHistorySync(sessionId, { force: true });

    window.setTimeout(() => {
      const next = useSessionShellHistoryStore.getState().getCommands(sessionId).length;
      if (next > prev) return;
      run();
    }, intervalMs * 3);
  };

  run();
}

/** useTerminal 初始化 PTY 发送器时注册，避免 TerminalView effect 竞态导致 sender 为空 */
export function registerShellHistoryPtySender(
  sessionId: string,
  sender: ((cmd: string) => void) | null,
): void {
  setTerminalPaneSender(sessionId, sender);
}
