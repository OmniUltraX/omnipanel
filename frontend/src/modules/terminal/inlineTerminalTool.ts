import {
  isAiThreadMessage,
  isAiThreadToolCall,
  type AiThreadItem,
  type AiThreadToolCall,
  type AiThreadToolCallStatus,
  type TerminalBlock,
} from "../../stores/blocksStore";
import { isHiddenChatToolName } from "../../lib/ai/hiddenChatTools";
import { SSH_EXEC_TOOL_NAME } from "../../lib/ai/toolHost";
import { getResolvedAiThread } from "./aiThreadBridge";
import { getPendingInlineToolScope } from "./inlineToolBridge";
import { shouldRequireTerminalApproval } from "./terminalApprovalPolicy";
import { resolveTerminalApprovalMode } from "./terminalApprovalSettings";

function resolveToolCallCommand(item: AiThreadToolCall): string {
  const direct = item.command?.trim();
  if (direct) return direct;
  try {
    const parsed = JSON.parse(item.args) as { command?: string };
    if (typeof parsed.command === "string" && parsed.command.trim()) {
      return parsed.command.trim();
    }
  } catch {
    // ignore
  }
  return "";
}

/** 在终端会话内联展示 / 审批的「跑命令」类工具（含历史别名）。 */
const INLINE_TERMINAL_TOOL_NAMES = new Set([
  SSH_EXEC_TOOL_NAME,
  "omni_terminal_run_terminal_command",
  "run_terminal_command",
]);

export function isInlineTerminalToolName(toolName: string): boolean {
  return INLINE_TERMINAL_TOOL_NAMES.has(toolName);
}

/**
 * 流内「调用工具」条：展示除跑命令以外的工具。
 * 执行命令走确认卡，ask_user / plan 有自己的卡，都不进工具条。
 */
export function isDisplayShellAgentToolName(toolName: string): boolean {
  if (!toolName.trim()) return false;
  if (isInlineTerminalToolName(toolName)) return false;
  if (isHiddenChatToolName(toolName)) return false;
  return true;
}

function collectToolCallsBy(
  thread: AiThreadItem[],
  include: (name: string) => boolean,
): AiThreadToolCall[] {
  const byId = new Map<string, AiThreadToolCall>();
  for (const item of thread) {
    if (isAiThreadToolCall(item) && include(item.toolName)) {
      byId.set(item.id, item);
    }
  }
  for (const item of thread) {
    if (!isAiThreadMessage(item) || item.role !== "assistant" || !item.parts?.length) continue;
    for (const part of item.parts) {
      if (part.type !== "tool-call") continue;
      if (!include(part.name)) continue;
      const partResult = typeof part.result === "string" ? part.result : undefined;
      const existing = byId.get(part.id);
      if (existing) {
        // tool_call 条目先写入、part 后补 result：展开确认卡必须能读到输出
        if (!existing.result?.trim() && partResult) {
          byId.set(part.id, { ...existing, result: partResult });
        }
        continue;
      }
      const args =
        typeof part.arguments === "string" ? part.arguments : JSON.stringify(part.arguments ?? {});
      byId.set(part.id, {
        kind: "tool_call",
        id: part.id,
        toolName: part.name,
        args,
        status: toolStatusFromPart(part.status),
        result: partResult,
        timestamp: item.timestamp,
      });
    }
  }
  return [...byId.values()];
}

function toolStatusFromPart(
  status: "pending" | "running" | "completed" | "failed" | undefined,
): AiThreadToolCallStatus {
  if (status === "pending") return "pending";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "running";
}

/**
 * 当前轮待确认 / 执行中的跑命令工具（确认卡用）。
 */
export function collectInlineTerminalToolCalls(thread: AiThreadItem[]): AiThreadToolCall[] {
  return collectToolCallsBy(thread, isInlineTerminalToolName);
}

/**
 * 当前轮应展示「调用工具」条的工具（不含跑命令 / ask / plan）。
 */
export function collectDisplayToolCalls(thread: AiThreadItem[]): AiThreadToolCall[] {
  return collectToolCallsBy(thread, isDisplayShellAgentToolName);
}

/** 一张流内条只画一条调用，避免多次 fetch 挤在同一张卡 */
export function pickLiveStripTools(
  toolCalls: AiThreadToolCall[],
  archivedIds: ReadonlySet<string>,
): AiThreadToolCall[] {
  const live = toolCalls.filter(
    (tc) => tc.status !== "rejected" && !archivedIds.has(tc.id),
  );
  return live.slice(0, 1);
}

/** 还有已出现但未画到当前条 / 未归档的 search/fetch */
export function hasUnshownDisplayTool(
  toolCalls: AiThreadToolCall[],
  archivedIds: ReadonlySet<string>,
  shownIds: Iterable<string> = [],
): boolean {
  const shown = shownIds instanceof Set ? shownIds : new Set(shownIds);
  return toolCalls.some(
    (tc) =>
      tc.status !== "rejected" &&
      !archivedIds.has(tc.id) &&
      !shown.has(tc.id),
  );
}

/** 查询尚未入 thread 时用占位切片，禁止回退到上一轮（否则会把旧 search 再钉一遍、冻空思考卡）。 */
export function selectThreadForInlineTools(
  thread: AiThreadItem[],
  turnThread: AiThreadItem[],
): AiThreadItem[] {
  if (turnThread.length === 0) return thread;
  return turnThread;
}

export type ActiveInlineTerminalTool = {
  blockId: string;
  item: AiThreadToolCall;
};

/** 当前会话中待确认或执行中的内联终端工具调用（取最新一条，免审批命令不展示） */
export function findActiveInlineTerminalTool(
  blocks: TerminalBlock[],
  sessionId: string,
): ActiveInlineTerminalTool | null {
  const mode = resolveTerminalApprovalMode(sessionId);

  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.kind !== "ai") continue;
    const thread = getResolvedAiThread(block);
    for (let j = thread.length - 1; j >= 0; j--) {
      const entry = thread[j];
      if (
        isAiThreadToolCall(entry) &&
        isInlineTerminalToolName(entry.toolName) &&
        (entry.status === "pending" || entry.status === "running")
      ) {
        const scope = getPendingInlineToolScope(entry.id, sessionId);
        if (scope.terminalSessionId && scope.terminalSessionId !== sessionId) continue;
        const command = resolveToolCallCommand(entry);
        if (
          command &&
          !shouldRequireTerminalApproval(command, mode, {
            conversationId: scope.conversationId,
            terminalSessionId: sessionId,
          })
        ) {
          continue;
        }
        return { blockId: block.id, item: entry };
      }
    }
  }
  return null;
}
