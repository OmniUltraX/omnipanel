import { commands } from "../../../ipc/bindings";
import { isOpenSshHostId } from "../../../lib/sshConfigHosts";
import { findTerminalPane } from "../../../stores/terminalStore";
import { useConnectionStore } from "../../../stores/connectionStore";
import { LOCAL_CONNECTION_ID } from "../../files/utils";
import { resolveTerminalShellFamily, type TerminalShellFamily } from "../terminalAutoLsShell";
import { normalizeHistoryCommands } from "./internalHistoryCommands";
import { useSessionShellHistoryStore } from "./sessionShellHistoryStore";
import { SHELL_HISTORY_SYNC_MAX } from "./shellHistorySync";

const inflightFetches = new Set<string>();
const FETCH_THROTTLE_MS = 15_000;
const LOCAL_HISTORY_MAX_BYTES = 2_000_000;

/** useTerminal 连接建立时写入，避免 store 未及时同步 backendSessionId */
const runtimeBackendIds = new Map<string, string>();

/** 已成功通过 PTY 注入同步过的后端会话，避免重连/切回时重复注入 */
export const ptyHistorySyncedBackendIds = new Set<string>();

export function registerRuntimeBackendSession(
  sessionId: string,
  backendId: string | null,
): void {
  if (backendId) runtimeBackendIds.set(sessionId, backendId);
  else runtimeBackendIds.delete(sessionId);
}

export function resolveBackendSessionId(sessionId: string): string | null {
  const pane = findTerminalPane(sessionId);
  if (pane?.backendSessionId) return pane.backendSessionId;
  return runtimeBackendIds.get(sessionId) ?? null;
}

function takeLastHistoryLines(text: string, maxLines = SHELL_HISTORY_SYNC_MAX): string[] {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    lines.push(line);
  }
  return lines.slice(-maxLines);
}

/** 解析 bash 历史文件（含 HISTTIMEFORMAT 时间戳行） */
export function parseBashHistoryContent(text: string): string[] {
  const lines: string[] = [];
  for (const raw of takeLastHistoryLines(text)) {
    if (/^#\d+$/.test(raw)) continue;
    lines.push(raw);
  }
  return lines;
}

function parsePlainShellHistoryContent(text: string): string[] {
  return takeLastHistoryLines(text);
}

function buildLocalShellHistoryPaths(shell: TerminalShellFamily): string[] {
  if (shell === "powershell") {
    return [
      "~/AppData/Roaming/Microsoft/Windows/PowerShell/PSReadLine/ConsoleHost_history.txt",
      "~/AppData/Roaming/Microsoft/PowerShell/PSReadLine/ConsoleHost_history.txt",
    ];
  }
  if (shell === "posix") {
    return ["~/.bash_history", "~/.zsh_history"];
  }
  return [];
}

async function readLocalHistoryFile(path: string): Promise<string | null> {
  try {
    const bytes = await commands.fileReadFile(
      LOCAL_CONNECTION_ID,
      path,
      LOCAL_HISTORY_MAX_BYTES,
    );
    if (!bytes?.length) return null;
    return new TextDecoder().decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

function applyHistoryLines(sessionId: string, lines: string[]): boolean {
  if (lines.length === 0) return false;
  const commandsList = normalizeHistoryCommands([...lines].reverse());
  if (commandsList.length === 0) return false;
  useSessionShellHistoryStore.getState().setCommands(sessionId, commandsList);
  const backendId = resolveBackendSessionId(sessionId);
  if (backendId) ptyHistorySyncedBackendIds.add(backendId);
  return true;
}

function shouldSkipFetch(sessionId: string): boolean {
  const syncedAt = useSessionShellHistoryStore.getState().getSyncedAt(sessionId);
  const existingCount = useSessionShellHistoryStore.getState().getCommands(sessionId).length;
  return (
    syncedAt > 0 &&
    Date.now() - syncedAt < FETCH_THROTTLE_MS &&
    existingCount >= 20
  );
}

/** 本机直读 shell 历史文件，避免向 PTY 注入同步脚本 */
async function fetchLocalShellHistory(sessionId: string): Promise<boolean> {
  const pane = findTerminalPane(sessionId);
  if (!pane || pane.type !== "local") return false;
  if (shouldSkipFetch(sessionId)) {
    return useSessionShellHistoryStore.getState().getCommands(sessionId).length > 0;
  }

  const shell = resolveTerminalShellFamily(pane.type, pane.shellLabel);
  const paths = buildLocalShellHistoryPaths(shell);
  if (paths.length === 0) return false;

  const parser = shell === "posix" ? parseBashHistoryContent : parsePlainShellHistoryContent;

  for (const path of paths) {
    const text = await readLocalHistoryFile(path);
    if (!text) continue;
    const lines = parser(text);
    if (applyHistoryLines(sessionId, lines)) return true;
  }
  return false;
}

function resolveSshUsername(resourceId: string): string {
  if (!resourceId) return "root";
  const conn = useConnectionStore.getState().connections.find((c) => c.id === resourceId);
  if (conn?.config) {
    try {
      const cfg = JSON.parse(conn.config) as { user?: string };
      if (cfg.user?.trim()) return cfg.user.trim();
    } catch {
      // ignore
    }
  }
  if (isOpenSshHostId(resourceId)) return "root";
  return "root";
}

function buildHistoryPaths(user: string, cwd: string): string[] {
  const paths: string[] = [];
  const add = (p: string) => {
    if (!paths.includes(p)) paths.push(p);
  };
  if (user === "root") add("/root/.bash_history");
  add(`/home/${user}/.bash_history`);
  const home = user === "root" ? "/root" : `/home/${user}`;
  add(`${home}/.bash_history`);
  if (cwd.startsWith("/")) {
    add(`${cwd.replace(/\/$/, "")}/.bash_history`);
  }
  return paths;
}

export async function fetchShellHistoryFromBackend(sessionId: string): Promise<boolean> {
  const pane = findTerminalPane(sessionId);
  if (!pane || pane.type !== "remote") return false;

  const backendId = resolveBackendSessionId(sessionId);
  if (!backendId) return false;

  if (shouldSkipFetch(sessionId)) {
    return useSessionShellHistoryStore.getState().getCommands(sessionId).length > 0;
  }

  const user = resolveSshUsername(pane.resourceId);
  const paths = buildHistoryPaths(user, pane.cwd ?? "");

  for (const remotePath of paths) {
    try {
      const res = await commands.sftpDownload(backendId, remotePath);
      if (res.status !== "ok" || !res.data?.length) continue;

      const text = new TextDecoder().decode(new Uint8Array(res.data));
      const lines = parseBashHistoryContent(text);
      if (applyHistoryLines(sessionId, lines)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

/** 优先文件直读（本地 / SFTP），失败才回退 PTY 静默同步 */
export async function fetchShellHistoryForSession(sessionId: string): Promise<boolean> {
  if (inflightFetches.has(sessionId)) return false;

  const pane = findTerminalPane(sessionId);
  if (!pane) return false;

  inflightFetches.add(sessionId);
  try {
    if (pane.type === "local") {
      return await fetchLocalShellHistory(sessionId);
    }
    return await fetchShellHistoryFromBackend(sessionId);
  } finally {
    inflightFetches.delete(sessionId);
  }
}
