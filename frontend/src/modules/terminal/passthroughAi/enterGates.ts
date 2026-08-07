/** 直通智能 Enter 门闩：alt-screen / reverse-i-search / 忙 / Agent 执行中 */

export type EnterGateFlags = {
  altScreen: boolean;
  reverseSearch: boolean;
  /** 前台命令运行中（OSC 区间或启发式） */
  commandRunning: boolean;
  /** Shell Agent 正在写 PTY / 采集 */
  agentExecuting: boolean;
  /** 用户当前行缓冲非空（正在打字）；续轮重锚会排队，打字结束后补锚 */
  userTyping: boolean;
};

export function createEnterGateFlags(): EnterGateFlags {
  return {
    altScreen: false,
    reverseSearch: false,
    commandRunning: false,
    agentExecuting: false,
    userTyping: false,
  };
}

const REVERSE_SEARCH_RE = /\((?:reverse-)?i-search\)/i;

export function detectReverseSearchInOutput(chunk: string): boolean {
  return REVERSE_SEARCH_RE.test(chunk);
}

/** Enter 是否允许做 NL 分流；不确定时由调用方结合 lineBuffer.reliable fail-open */
export function canInterceptEnterForAi(flags: EnterGateFlags): boolean {
  if (flags.altScreen) return false;
  if (flags.reverseSearch) return false;
  if (flags.commandRunning) return false;
  if (flags.agentExecuting) return false;
  return true;
}

const sessionGates = new Map<string, EnterGateFlags>();

export function getEnterGateFlags(sessionId: string): EnterGateFlags {
  let flags = sessionGates.get(sessionId);
  if (!flags) {
    flags = createEnterGateFlags();
    sessionGates.set(sessionId, flags);
  }
  return { ...flags };
}

export function patchEnterGateFlags(
  sessionId: string,
  patch: Partial<EnterGateFlags>,
): EnterGateFlags {
  const next = { ...getEnterGateFlags(sessionId), ...patch };
  sessionGates.set(sessionId, next);
  return next;
}

export function clearEnterGateFlags(sessionId: string): void {
  sessionGates.delete(sessionId);
}
