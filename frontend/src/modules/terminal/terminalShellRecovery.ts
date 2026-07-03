import { useTerminalUiStore } from "./terminalUiStore";
import { writeTerminalRaw, hasTerminalRawWriter } from "./terminalPaneSenders";
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
  if (isShellPromptRecent(sessionId, 120)) return;
  await interruptShell(sessionId, 1);
  await sleep(100);
}

/** AI 工具执行后：确保回到 shell 主提示符，并回到 Command Bar 模式 */
export async function recoverShellAfterAiTool(sessionId: string): Promise<void> {
  await ensureShellAtPrompt(sessionId, { maxAttempts: 3 });

  const ui = useTerminalUiStore.getState();
  if (ui.getInputMode(sessionId) === "interactive") {
    ui.returnToCommandBar(sessionId);
  }
}
