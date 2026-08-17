import {
  coalescePartsByToolSegments,
  type AiMessagePart,
} from "../../../lib/ai/aiMessageParts";
import type {
  AiThreadItem,
  AiThreadMessage,
  AiThreadToolCall,
} from "../../../stores/blocksStore";

function isAiThreadMessage(item: AiThreadItem): item is AiThreadMessage {
  return item.kind === "message";
}

function isAiThreadToolCall(item: AiThreadItem): item is AiThreadToolCall {
  return item.kind === "tool_call";
}

export function lastUserIndex(thread: AiThreadItem[]): number {
  for (let i = thread.length - 1; i >= 0; i -= 1) {
    const item = thread[i];
    if (isAiThreadMessage(item) && item.role === "user") return i;
  }
  return -1;
}

export function currentTurnItems(thread: AiThreadItem[]): AiThreadItem[] {
  const i = lastUserIndex(thread);
  return i < 0 ? thread : thread.slice(i + 1);
}

/**
 * 把 thread 收束到「当前蓝字问题」这一轮。
 * 新问题已画卡但 user 消息还没入 thread 时返回仅含该 user 的占位，避免读到上一轮思考。
 */
export function scopeThreadToQuery(
  thread: AiThreadItem[],
  query?: string | null,
): AiThreadItem[] {
  const hint = query?.trim();
  if (!hint) return thread;
  for (let i = thread.length - 1; i >= 0; i -= 1) {
    const item = thread[i];
    if (
      isAiThreadMessage(item) &&
      item.role === "user" &&
      item.content.trim() === hint
    ) {
      return thread.slice(i);
    }
  }
  return [
    {
      kind: "message",
      id: "__pending_turn__",
      role: "user",
      content: hint,
      timestamp: 0,
    },
  ];
}

type TurnSeg =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; id: string };

function isTextPart(part: AiMessagePart): part is { type: "text"; text: string } {
  return part.type === "text";
}

function isToolCallPart(
  part: AiMessagePart,
): part is Extract<AiMessagePart, { type: "tool-call" }> {
  return part.type === "tool-call";
}

function isReasoningPart(part: AiMessagePart): part is { type: "reasoning"; text: string } {
  return part.type === "reasoning";
}

/**
 * 本轮线性片段：助手 text / tool-call parts + 独立 tool_call 条。
 * 流式把多轮正文写进同一条 assistant（content 会拼成一团），必须按 parts 切段，
 * 否则后续确认卡/结果卡会一直显示第一段「当前时间是…」。
 */
function currentTurnSegments(thread: AiThreadItem[]): TurnSeg[] {
  const turn = currentTurnItems(thread);
  const seenTools = new Set<string>();
  const segs: TurnSeg[] = [];

  const pushText = (raw: string) => {
    const text = raw.trim();
    if (text) segs.push({ kind: "text", text });
  };

  const pushTool = (id: string) => {
    if (!id || seenTools.has(id)) return;
    seenTools.add(id);
    segs.push({ kind: "tool", id });
  };

  const pushReasoning = (raw: string) => {
    const text = raw.trim();
    if (text) segs.push({ kind: "reasoning", text });
  };

  for (const item of turn) {
    if (isAiThreadMessage(item) && item.role === "assistant") {
      const rawParts =
        item.parts && item.parts.length > 0
          ? item.parts
          : [
              ...(item.reasoning?.trim()
                ? ([{ type: "reasoning", text: item.reasoning }] as AiMessagePart[])
                : []),
              ...(item.content?.trim()
                ? ([{ type: "text", text: item.content }] as AiMessagePart[])
                : []),
            ];
      const parts = coalescePartsByToolSegments(rawParts);
      for (const part of parts) {
        if (isReasoningPart(part)) pushReasoning(part.text);
        else if (isTextPart(part)) pushText(part.text);
        else if (isToolCallPart(part)) pushTool(part.id);
      }
      continue;
    }
    if (isAiThreadToolCall(item)) pushTool(item.id);
  }
  return segs;
}

function lastText(segs: TurnSeg[]): string {
  for (let i = segs.length - 1; i >= 0; i -= 1) {
    const seg = segs[i];
    if (seg?.kind === "text") return seg.text;
  }
  return "";
}

function joinTexts(segs: TurnSeg[]): string {
  return segs
    .filter((s): s is { kind: "text"; text: string } => s.kind === "text")
    .map((s) => s.text)
    .join("\n\n");
}

function lastReasoningFromMessage(item: AiThreadMessage): string {
  const rawParts =
    item.parts && item.parts.length > 0
      ? item.parts
      : item.reasoning?.trim()
        ? ([{ type: "reasoning", text: item.reasoning }] as AiMessagePart[])
        : [];
  const parts = coalescePartsByToolSegments(rawParts);
  const joined = parts
    .filter(isReasoningPart)
    .map((p) => p.text)
    .join("");
  if (joined.trim()) return joined.trim();
  return (item.reasoning ?? "").trim();
}

function lastNonEmptyLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

function windowPlain(window: TurnSeg[]): string {
  return window
    .filter(
      (s): s is { kind: "text" | "reasoning"; text: string } =>
        s.kind === "text" || s.kind === "reasoning",
    )
    .map((s) => s.text)
    .join("\n");
}

/** 工具边界插入后刷进来的思考尾巴，不是新一轮思考 / 结果解读 */
export function isToolBoundaryLeftover(before: string, after: string): boolean {
  const a = before.trim();
  const b = after.trim();
  if (!b) return true;
  if (!a) return false;
  if (b === lastNonEmptyLine(a)) return true;
  if (a.endsWith(b) || a.includes(b)) return true;
  return false;
}

function dropLeftoverSegs(before: TurnSeg[], after: TurnSeg[]): TurnSeg[] {
  const plain = windowPlain(before);
  return after.filter((s) => {
    if (s.kind !== "text" && s.kind !== "reasoning") return true;
    return !isToolBoundaryLeftover(plain, s.text);
  });
}

function prevToolIndex(segs: TurnSeg[], before: number): number {
  for (let i = before - 1; i >= 0; i -= 1) {
    if (segs[i]?.kind === "tool") return i;
  }
  return -1;
}

function isPendingToolId(thread: AiThreadItem[], toolId: string): boolean {
  if (!toolId) return false;
  let pending = false;
  for (const item of thread) {
    if (isAiThreadToolCall(item) && item.id === toolId && item.status === "pending") {
      pending = true;
    }
    if (isAiThreadMessage(item) && item.parts) {
      for (const part of item.parts) {
        if (isToolCallPart(part) && part.id === toolId && part.status === "pending") {
          pending = true;
        }
      }
    }
  }
  return pending;
}

function segsInCurrentThinkingWindow(thread: AiThreadItem[]): TurnSeg[] {
  const segs = currentTurnSegments(thread);
  let lastTool = -1;
  for (let i = segs.length - 1; i >= 0; i -= 1) {
    if (segs[i]?.kind === "tool") {
      lastTool = i;
      break;
    }
  }
  if (lastTool < 0) return segs;

  const last = segs[lastTool];
  const lastId = last?.kind === "tool" ? last.id : "";
  // 待确认：思考属于该工具之前。tool 边界插入后 RAF 刷入的尾巴（如 ni_ssh_exec.）
  // 不是新一轮思考，禁止只取 after 把全文丢掉。
  if (isPendingToolId(thread, lastId)) {
    return segs.slice(prevToolIndex(segs, lastTool) + 1, lastTool);
  }

  const before = segs.slice(prevToolIndex(segs, lastTool) + 1, lastTool);
  const after = dropLeftoverSegs(before, segs.slice(lastTool + 1));
  const reasoningAfter = after.filter((s) => s.kind === "reasoning");
  if (reasoningAfter.length > 0) return reasoningAfter;
  // 工具后的 text 是结果解读，不是新思考；无新 reasoning 则思考卡必须空着
  return [];
}

function joinWindowThinking(window: TurnSeg[]): string {
  const reasoning = window
    .filter((s): s is { kind: "reasoning"; text: string } => s.kind === "reasoning")
    .map((s) => s.text)
    .join("");
  if (reasoning.trim()) return reasoning.trim();
  return window
    .filter((s): s is { kind: "text"; text: string } => s.kind === "text")
    .map((s) => s.text)
    .join("\n\n")
    .trim();
}

/** 当前思考卡正文：本窗口全部 reasoning（碎片合并），不要只取最后一句 */
export function currentTurnThinkingText(thread: AiThreadItem[]): string {
  return joinWindowThinking(segsInCurrentThinkingWindow(thread));
}

/** 确认卡旁注：本轮、该工具之前、上一工具之后。没有则空，绝不借用上一轮。 */
export function assistantNoteForTool(
  thread: AiThreadItem[],
  toolId: string | null,
): string {
  const segs = currentTurnSegments(thread);
  if (!toolId) return lastText(segs);
  const idx = segs.findIndex((s) => s.kind === "tool" && s.id === toolId);
  if (idx < 0) return lastText(segs);
  let prevTool = -1;
  for (let i = idx - 1; i >= 0; i -= 1) {
    if (segs[i]?.kind === "tool") {
      prevTool = i;
      break;
    }
  }
  return joinTexts(segs.slice(prevTool + 1, idx));
}

export function currentTurnReasoning(thread: AiThreadItem[]): string {
  const turn = currentTurnItems(thread);
  let last = "";
  for (const item of turn) {
    if (!isAiThreadMessage(item) || item.role !== "assistant") continue;
    const next = lastReasoningFromMessage(item);
    if (next) last = next;
  }
  return last;
}

export function currentTurnAssistant(thread: AiThreadItem[]): string {
  return lastText(currentTurnSegments(thread));
}

/** 结果卡解读：本轮最后一个工具之后的助手正文；尚无则空 */
export function currentTurnInterpretation(thread: AiThreadItem[]): string {
  const segs = currentTurnSegments(thread);
  let lastTool = -1;
  for (let i = segs.length - 1; i >= 0; i -= 1) {
    if (segs[i]?.kind === "tool") {
      lastTool = i;
      break;
    }
  }
  if (lastTool < 0) return lastText(segs);
  const before = segs.slice(prevToolIndex(segs, lastTool) + 1, lastTool);
  return joinTexts(dropLeftoverSegs(before, segs.slice(lastTool + 1)));
}

/** 本轮该工具之前是否已有其它工具（后续确认卡不要重复上一工具的结果正文） */
export function toolHasPriorInTurn(thread: AiThreadItem[], toolId: string | null): boolean {
  if (!toolId) return false;
  const segs = currentTurnSegments(thread);
  const idx = segs.findIndex((s) => s.kind === "tool" && s.id === toolId);
  if (idx < 0) return false;
  return segs.slice(0, idx).some((s) => s.kind === "tool");
}

/**
 * 结果卡正文：优先「上一完成工具之后、下一 pending 之前」；
 * 否则取最后一个工具之后的解读。
 */
export function currentTurnResultText(thread: AiThreadItem[]): string {
  const turn = currentTurnItems(thread);
  for (let i = turn.length - 1; i >= 0; i -= 1) {
    const item = turn[i];
    if (isAiThreadToolCall(item) && item.status === "pending") {
      const note = assistantNoteForTool(thread, item.id);
      if (note) return note;
      break;
    }
  }
  return currentTurnInterpretation(thread);
}
