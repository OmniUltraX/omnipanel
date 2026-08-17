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

export function isPendingTurnThread(thread: AiThreadItem[]): boolean {
  return thread.length === 1 && thread[0]?.id === "__pending_turn__";
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

function firstNonEmptyLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[0] ?? "";
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

const SENTENCE_END_RE = /[。．.！？!?…)」』]\s*$/;

/** 工具后真正开始新思考的标志；标志之前的短前缀属于工具前末行 */
const NEW_THOUGHT_RE =
  /搜索结果已经|我已经用|现在需要按照|现在需要|接下来要|接下来|根据.{0,8}结果|搜索完成/;

/** 工具结果之后的新思考，不是工具 part 后才刷进来的同窗正文 */
export function isNewPostToolThought(text: string): boolean {
  return NEW_THOUGHT_RE.test(text.trim());
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

function longestSuffixPrefixOverlap(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  for (let n = max; n >= 4; n -= 1) {
    if (left.slice(-n) === right.slice(0, n)) return n;
  }
  return 0;
}

/**
 * 工具插入把流式思考切开后，后窗开头常是前窗末行残片
 * （`今天 8月17日" 搜索` / `etch 抓取…`）。返回应从 after 去掉的前缀长度。
 */
function leftoverPrefixLength(before: string, after: string): number {
  const a = before.trimEnd();
  const b = after.trimStart();
  if (!a || !b) return 0;
  if (isToolBoundaryLeftover(a, b)) return b.length;

  const last = lastNonEmptyLine(a);
  const first = firstNonEmptyLine(b);
  const lead = after.length - b.length;

  const prefixThrough = (endInB: number): number => {
    let i = endInB;
    while (i < b.length && /[\s]/.test(b[i] ?? "")) i += 1;
    return lead + i;
  };

  if (last.length >= 4) {
    if (b.startsWith(last)) return prefixThrough(last.length);
    if (first && (last === first || last.endsWith(first))) {
      const idx = b.indexOf(first);
      if (idx >= 0) return prefixThrough(idx + first.length);
    }
    if (first.length >= 4 && first.length <= 80 && last.includes(first)) {
      const idx = b.indexOf(first);
      if (idx >= 0) return prefixThrough(idx + first.length);
    }
    const overlap = longestSuffixPrefixOverlap(last, b);
    if (overlap >= 4) {
      if (first && first.length <= 80 && overlap >= Math.min(first.length, overlap)) {
        const idx = b.indexOf(first);
        if (idx >= 0 && first.length <= overlap + 16) {
          return prefixThrough(idx + first.length);
        }
      }
      return prefixThrough(overlap);
    }
  }

  if (SENTENCE_END_RE.test(a)) return 0;

  // 同一行里「末行残片 + 新思考」：无字符重叠时（历史上的 | 今天 8月17日" 搜索结果已经…）
  const marker = NEW_THOUGHT_RE.exec(b);
  if (marker && marker.index > 0 && marker.index <= 48) {
    const prefix = b.slice(0, marker.index);
    if (!SENTENCE_END_RE.test(prefix.trimEnd())) {
      return prefixThrough(marker.index);
    }
  }

  if (!/^[a-z0-9]/.test(b)) return 0;
  const m = b.match(/^[^\n。．.！？!?]+(?:[\n。．.！？!?]+)?/);
  return m ? lead + m[0].length : 0;
}

function glueThinkingFragment(before: string, fragment: string): string {
  const a = before.trimEnd();
  const f = fragment.trim();
  if (!a) return f;
  if (!f) return a;
  if (a.endsWith(f) || a.includes(f)) return a;
  if (/[a-zA-Z0-9_]$/.test(a) && /^[a-z0-9]/.test(f)) return `${a}${f}`;
  return `${a}${f}`;
}

/** 模型把工具前推理整段重放进工具后时，只保留新增后缀 */
function stripAccumulatedPrefix(before: string, after: string): string {
  const a = before.trim();
  const b = after.trim();
  if (!b) return "";
  if (!a) return b;
  if (isToolBoundaryLeftover(a, b)) return "";
  if (b.startsWith(a)) return b.slice(a.length).trim();
  const idx = b.indexOf(a);
  if (idx > 0 && idx <= 32) return b.slice(idx + a.length).trim();
  const n = leftoverPrefixLength(before, after);
  if (n > 0) return after.slice(n).trim();
  return b;
}

function mergeLeftoverIntoBefore(before: TurnSeg[], after: TurnSeg[]): TurnSeg[] {
  const first = after.find(
    (s): s is { kind: "text" | "reasoning"; text: string } =>
      s.kind === "text" || s.kind === "reasoning",
  );
  if (!first) return before;
  const plain = windowPlain(before);
  let fragment = "";
  if (isToolBoundaryLeftover(plain, first.text)) {
    fragment = first.text.trim();
  } else {
    const n = leftoverPrefixLength(plain, first.text);
    if (n > 0) fragment = first.text.slice(0, n).trim();
  }
  if (!fragment) return before;
  let lastIdx = -1;
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const s = before[i];
    if (s && (s.kind === "text" || s.kind === "reasoning")) {
      lastIdx = i;
      break;
    }
  }
  if (lastIdx < 0) {
    return [...before, { kind: "reasoning", text: fragment }];
  }
  const last = before[lastIdx];
  if (last?.kind !== "text" && last?.kind !== "reasoning") return before;
  const copy = before.slice();
  copy[lastIdx] = { ...last, text: glueThinkingFragment(last.text, fragment) };
  return copy;
}

function firstWindowText(
  segs: TurnSeg[],
): { kind: "text" | "reasoning"; text: string } | undefined {
  return segs.find(
    (s): s is { kind: "text" | "reasoning"; text: string } =>
      s.kind === "text" || s.kind === "reasoning",
  );
}

/** 工具边界切开后、后窗开头属于前窗末行的残片（用于补回已冻结的思考卡） */
export function toolBoundaryLeftoverFragment(thread: AiThreadItem[]): string {
  const segs = currentTurnSegments(thread);
  let lastTool = -1;
  for (let i = segs.length - 1; i >= 0; i -= 1) {
    if (segs[i]?.kind === "tool") {
      lastTool = i;
      break;
    }
  }
  if (lastTool < 0) return "";
  const before = segs.slice(prevToolIndex(segs, lastTool) + 1, lastTool);
  const first = firstWindowText(segs.slice(lastTool + 1));
  if (!first) return "";
  const plain = windowPlain(before);
  if (isToolBoundaryLeftover(plain, first.text)) return first.text.trim();
  const n = leftoverPrefixLength(plain, first.text);
  if (n <= 0) return "";
  return first.text.slice(0, n).trim();
}

function dropLeftoverSegs(before: TurnSeg[], after: TurnSeg[]): TurnSeg[] {
  const plain = windowPlain(before);
  const out: TurnSeg[] = [];
  for (const s of after) {
    if (s.kind !== "text" && s.kind !== "reasoning") {
      out.push(s);
      continue;
    }
    const stripped = stripAccumulatedPrefix(plain, s.text);
    if (!stripped) continue;
    out.push(stripped === s.text.trim() ? s : { ...s, text: stripped });
  }
  return out;
}

function prevToolIndex(segs: TurnSeg[], before: number): number {
  for (let i = before - 1; i >= 0; i -= 1) {
    if (segs[i]?.kind === "tool") return i;
  }
  return -1;
}

function isOpenToolStatus(status: string | undefined): boolean {
  return status === "pending" || status === "running";
}

/** 待确认 / 执行中：思考仍属于该工具之前（search/fetch 通常是 running 而非 pending） */
function isOpenToolId(thread: AiThreadItem[], toolId: string): boolean {
  if (!toolId) return false;
  let open = false;
  for (const item of thread) {
    if (isAiThreadToolCall(item) && item.id === toolId && isOpenToolStatus(item.status)) {
      open = true;
    }
    if (isAiThreadMessage(item) && item.parts) {
      for (const part of item.parts) {
        if (isToolCallPart(part) && part.id === toolId && isOpenToolStatus(part.status)) {
          open = true;
        }
      }
    }
  }
  return open;
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
  // 待确认 / 执行中：思考属于该工具之前。tool 边界插入后 RAF 刷入的尾巴
  // 不是新一轮思考，禁止只取 after 把全文丢掉。
  if (isOpenToolId(thread, lastId)) {
    const before = segs.slice(prevToolIndex(segs, lastTool) + 1, lastTool);
    const after = segs.slice(lastTool + 1);
    const merged = mergeLeftoverIntoBefore(before, after);
    if (joinWindowThinking(merged).trim()) return merged;
    // 工具 part 先插入、思考 delta 还在 tool-call 后面：整段 after 仍属当前思考卡
    const afterThink = after.filter(
      (s): s is { kind: "text" | "reasoning"; text: string } =>
        s.kind === "text" || s.kind === "reasoning",
    );
    return afterThink.length > 0 ? afterThink : merged;
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
