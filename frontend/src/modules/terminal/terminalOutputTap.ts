/**
 * 终端输出 chunk 轻量订阅：供「清行后等回显静默」等时序纪律使用。
 * 在 useTerminal 输出流（feedTerminalOutputForWatch 同点）接入。
 */

type OutputListener = (chunk: string) => void;

const listeners = new Map<string, Set<OutputListener>>();

/** 输出流入口调用；chunk 为剥离控制序列后的可见文本（仅判活，不解析内容） */
export function tapTerminalOutput(sessionId: string, chunk: string): void {
  const set = listeners.get(sessionId);
  if (!set || set.size === 0) return;
  for (const fn of set) {
    try {
      fn(chunk);
    } catch {
      // 监听器异常不影响输出主链路
    }
  }
}

export function onTerminalOutput(sessionId: string, fn: OutputListener): () => void {
  let set = listeners.get(sessionId);
  if (!set) {
    set = new Set();
    listeners.set(sessionId, set);
  }
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) listeners.delete(sessionId);
  };
}

/**
 * 等待输出静默：最近 idleMs 内无任何输出 chunk 即 resolve(true)；
 * timeoutMs 内始终不静默则 resolve(false)（调用方按 fail-open 继续）。
 */
export function waitForTerminalOutputIdle(
  sessionId: string,
  idleMs = 60,
  timeoutMs = 900,
): Promise<boolean> {
  return new Promise((resolve) => {
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let done = false;

    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      off();
      resolve(ok);
    };

    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(true), idleMs);
    };

    const off = onTerminalOutput(sessionId, armIdle);
    const hardTimer = setTimeout(() => finish(false), timeoutMs);
    // 若本就无输出，idleMs 后直接就绪
    armIdle();
  });
}
