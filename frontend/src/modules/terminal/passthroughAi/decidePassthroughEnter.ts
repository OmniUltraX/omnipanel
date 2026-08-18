import { shouldRouteInputToAi } from "../commandInputRouting";
import { canInterceptEnterForAi, getEnterGateFlags } from "./enterGates";
import type { LineBufferState } from "./lineBuffer";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useShellAgentStore } from "../shellAgent/shellAgentStore";
import { useTerminalRunStateStore } from "../terminalRunStateStore";

export type PassthroughEnterDecision =
  | { action: "passthrough" }
  | { action: "route_ai"; query: string }
  | { action: "approve_pending" };

/**
 * 确认卡回车：用户没在打字、没在 alt-screen / 执行中即可同意。
 * 不看屏幕行残留（光标常停在蓝字问题行，fromScreen 会是上次 NL）。
 */
export function canApprovePendingWithEnter(sessionId: string): boolean {
  const flags = getEnterGateFlags(sessionId);
  if (flags.userTyping) return false;
  if (flags.altScreen || flags.reverseSearch || flags.agentExecuting) return false;
  return true;
}

/**
 * 直通 Enter 决策：门闩 + 设置 + NL 启发式。
 * 明确像自然语言时优先入环；仅在「不像 NL / 空行 / 门闩关闭」时放行 PTY。
 * 确认卡空行回车视为同意（不依赖 NL 分流开关）。
 * 注意：中文 IME 常使行缓冲 reliable=false，不能因此 fail-open 把 NL 送进壳。
 */
export function decidePassthroughEnter(
  sessionId: string,
  lineBuffer: LineBufferState,
  /** 可选：从 xterm 当前行剥离提示符后的候选文本 */
  screenLineHint?: string,
): PassthroughEnterDecision {
  const flags = getEnterGateFlags(sessionId);
  const fromBuffer = lineBuffer.text.trim();
  const fromScreen = (screenLineHint ?? "").trim();
  const awaiting =
    useShellAgentStore.getState().get(sessionId)?.phase === "awaiting_approval";

  // 确认卡优先于 commandRunning 等 NL 门闩：否则 PTY 空回车，按钮没反应
  if (awaiting && !fromBuffer && canApprovePendingWithEnter(sessionId)) {
    return { action: "approve_pending" };
  }

  if (!canInterceptEnterForAi(flags)) {
    return { action: "passthrough" };
  }

  // 前台命令运行中（apt 交互 / top / vim 等）：所有输入直通 PTY，禁止 NL 分流
  // commandRunning flag 生产代码未设置，用 runStateStore 的 isCommandLive 兜底
  if (useTerminalRunStateStore.getState().isCommandLive(sessionId) && !awaiting) {
    return { action: "passthrough" };
  }

  // Agent 忙且正在写 PTY：放行 Enter（前台进程输入）
  if (useShellAgentStore.getState().isBusy(sessionId) && flags.agentExecuting) {
    return { action: "passthrough" };
  }

  if (!useSettingsStore.getState().terminalPassthroughAiEnter) {
    return { action: "passthrough" };
  }

  const candidates = [fromBuffer, fromScreen].filter(Boolean);

  for (const query of candidates) {
    if (shouldRouteInputToAi(query)) {
      return { action: "route_ai", query };
    }
  }

  // 缓冲不可信且没有明确 NL：放行，避免误吞真命令
  if (!lineBuffer.reliable && !fromBuffer) {
    return { action: "passthrough" };
  }

  return { action: "passthrough" };
}
