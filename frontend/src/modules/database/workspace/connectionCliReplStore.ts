/** 连接命令行 REPL 会话缓存：切工作区 / 子 Tab 卸载后仍保留输出与历史。 */

export interface CliReplSessionState {
  lines: string[];
  buffer: string;
  input: string;
  history: string[];
}

const sessions = new Map<string, CliReplSessionState>();

export function loadCliReplSession(connectionId: string): CliReplSessionState | null {
  return sessions.get(connectionId) ?? null;
}

export function saveCliReplSession(connectionId: string, state: CliReplSessionState): void {
  sessions.set(connectionId, {
    lines: state.lines,
    buffer: state.buffer,
    input: state.input,
    history: [...state.history],
  });
}

export function clearCliReplSession(connectionId: string): void {
  sessions.delete(connectionId);
}
