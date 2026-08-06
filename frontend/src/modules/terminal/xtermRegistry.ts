import type { Terminal } from "@xterm/xterm";

/** sessionId → 存活 xterm 实例（tabs / 嵌入 pane 共用） */
const bySession = new Map<string, Terminal>();

export function registerXterm(sessionId: string, term: Terminal): void {
  bySession.set(sessionId, term);
}

export function unregisterXterm(sessionId: string, term?: Terminal): void {
  const cur = bySession.get(sessionId);
  if (!cur) return;
  if (term && cur !== term) return;
  bySession.delete(sessionId);
}

export function getXterm(sessionId: string): Terminal | null {
  return bySession.get(sessionId) ?? null;
}
