import { useTerminalUiStore } from "./terminalUiStore";
import { writeTerminalRaw, hasTerminalRawWriter } from "./terminalPaneSenders";
import { useShellAgentStore } from "./shellAgent/shellAgentStore";
const PROMPT_RECENCY_MS = 350;

/** OSC 133;A 或等价 prompt 就绪信号（由 useTerminal 写入） */
const lastShellPromptAt = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function markShellPromptReady(sessionId: string): void {
  lastShellPromptAt.set(sessionId, Date.now());
}

function isShellPromptRecent(sessionId: string, withinMs = PROMPT_RECENCY_MS): boolean {
  const at = lastShellPromptAt.get(sessionId) ?? 0;
  return Date.now() - at < withinMs;
}

export function waitForShellPrompt(
  sessionId: string,
  timeoutMs: number,
): Promise<boolean> {
  if (isShellPromptRecent(sessionId)) return Promise.resolve(true);
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (isShellPromptRecent(sessionId)) {
        resolve(true);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        resolve(false);
        return;
      }
      window.setTimeout(tick, 40);
    };
    tick();
  });
}

/** 向 PTY 发送 Ctrl+C（可多次），打断续行提示符 / REPL / TUI */
export async function interruptShell(sessionId: string, times = 2): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    writeTerminalRaw(sessionId, "\x03");
    if (i + 1 < times) await sleep(80);
  }
}

/** 轮询 prompt 信号；必要时 Ctrl+C 清场 */
export async function ensureShellAtPrompt(
  sessionId: string,
  options?: { maxAttempts?: number },
): Promise<boolean> {
  const maxAttempts = options?.maxAttempts ?? 3;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (await waitForShellPrompt(sessionId, attempt === 0 ? 500 : 700)) {
      return true;
    }
    await interruptShell(sessionId, 2);
    writeTerminalRaw(sessionId, "\n");
    await sleep(160);
  }
  return isShellPromptRecent(sessionId, PROMPT_RECENCY_MS * 2);
}

/** AI 工具执行前：清掉可能残留的续行 / 子程序状态 */
export async function prepareShellForAiTool(sessionId: string): Promise<void> {
  if (!hasTerminalRawWriter(sessionId)) return;
  // Shell Agent 刚清行/绘蓝字后：信任近期 prompt，勿 Ctrl+C
  const agent = useShellAgentStore.getState().get(sessionId);
  if (agent && agent.phase !== "cancelled") {
    markShellPromptReady(sessionId);
    return;
  }
  if (isShellPromptRecent(sessionId, 120)) return;
  await interruptShell(sessionId, 1);
  await sleep(100);
}

/**
 * AI 工具执行后：确保回到 shell 主提示符。
 * Shell Agent 直通环：命令已在真 PTY 跑完，禁止 Ctrl+C 清场（否则满屏 ^C）。
 * 仅当会话带 autoReturn（命令栏临时进原生）时才切回 Command Bar。
 */
export async function recoverShellAfterAiTool(sessionId: string): Promise<void> {
  const ui = useTerminalUiStore.getState();
  const inputMode = ui.getInputMode(sessionId);
  const agent = useShellAgentStore.getState().get(sessionId);
  const inShellAgentLoop =
    inputMode === "interactive" &&
    Boolean(agent) &&
    agent!.phase !== "cancelled";

  if (inShellAgentLoop) {
    markShellPromptReady(sessionId);
    return;
  }

  await ensureShellAtPrompt(sessionId, { maxAttempts: 3 });

  if (ui.shouldAutoReturnToCommandBar(sessionId)) {
    ui.returnToCommandBar(sessionId);
  }
}
