/**
 * omni_ask_user dispatcher：结构化澄清表单。
 *
 * 数据流：
 * 1. AI 调用 → 后端挂起 → dispatchPendingTool 拦截 → 本 dispatcher 写 user-question part
 * 2. 用户提交/跳过 → aiChatToolResult 回传 → 会话续跑
 * 3. 同会话新的 ask_user 会 supersede 旧 pending 表单
 *
 * 双存储支持：
 * - 侧边栏 AI 会话：消息存储在 useAiStore.conversations
 * - 终端内嵌会话：消息存储在 useBlocksStore.<blockId>.aiThread
 *   conversationId 以 "term-inline:" 开头时自动走 blocksStore 路径
 */
import { useAiStore } from "../../../stores/aiStore";
import { useBlocksStore } from "../../../stores/blocksStore";
import { notifyShellAgentAskResolved } from "../../../modules/terminal/shellAgent/loop";
import { reportToolResultWithRetry } from "../reportToolResult";
import { appendChatOssEvent } from "../chatOssRecorder";
import type { AskUserAnswerValue, UserQuestionFormData } from "../aiMessageParts";
import {
  parseAskUserArgs,
  serializeAskUserResult,
  validateAskUserAnswers,
} from "./askUserSchema";

export const ASK_USER_TOOL = "omni_ask_user";
export {
  parseAskUserArgs,
  serializeAskUserResult,
  validateAskUserAnswers,
} from "./askUserSchema";

export type AskUserDispatchOptions = {
  conversationId: string;
  toolCallId: string;
  argsJson: string;
  /** 终端内嵌场景：提供 blockId 后消息从 blocksStore 查找/写入 */
  inline?: { blockId: string; assistantTurnId?: string | null } | null;
};

const resolvedToolCallIds = new Set<string>();

let formSeq = 0;
function genFormId(): string {
  return `ask_${Date.now()}_${(++formSeq).toString(36)}`;
}

/** 在 blocksStore 的 aiThread 中查找包含 toolCallId 的 assistant 消息 */
function findInlineParentMessage(blockId: string, toolCallId: string): {
  messageId: string;
} | null {
  const block = useBlocksStore.getState().findBlockById(blockId);
  if (!block?.aiThread) return null;
  for (const item of block.aiThread) {
    if (item.kind !== "message") continue;
    const parts = item.parts ?? [];
    const found = parts.some(
      (p) => p.type === "tool-call" && p.id === toolCallId,
    );
    if (found) return { messageId: item.id };
  }
  // fallback：最后一条 assistant 消息
  for (let i = block.aiThread.length - 1; i >= 0; i--) {
    const item = block.aiThread[i]!;
    if (item.kind === "message" && item.role === "assistant") {
      return { messageId: item.id };
    }
  }
  return null;
}

type ParentRef =
  | { kind: "aiStore"; messageId: string }
  | { kind: "blocksStore"; messageId: string; blockId: string }
  | null;

function findParentMessage(
  conversationId: string,
  toolCallId: string,
  inline?: { blockId: string; assistantTurnId?: string | null } | null,
): ParentRef {
  // 终端内嵌场景：从 blocksStore 查找
  if (inline?.blockId) {
    const found = findInlineParentMessage(inline.blockId, toolCallId);
    if (found) {
      return { kind: "blocksStore", messageId: found.messageId, blockId: inline.blockId };
    }
    // assistantTurnId fallback
    if (inline.assistantTurnId) {
      return {
        kind: "blocksStore",
        messageId: inline.assistantTurnId,
        blockId: inline.blockId,
      };
    }
    return null;
  }

  // 侧边栏场景：从 aiStore 查找
  const conv = useAiStore.getState().conversations.find((c) => c.id === conversationId);
  if (!conv) return null;

  // 1) 精确匹配：消息 parts 里包含该 toolCallId（通常场景）
  const matched = conv.messages.find(
    (m) =>
      Array.isArray(m.parts) &&
      m.parts.some((p) => p.type === "tool-call" && p.id === toolCallId),
  );
  if (matched) return { kind: "aiStore", messageId: matched.id };

  // 2) Fallback：在 streaming 异步写入或 tool-call part 尚未完整挂载时，
  //    找不到精确匹配是正常的。此时回退到「会话最近一条 assistant 消息」：
  //    只要 part 能写进去，后续 UI 就会正常渲染表单供用户提交。
  //    （从后往前遍历即可得到最新一条）
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i]!;
    if (m.role === "assistant" && Array.isArray(m.parts)) {
      return { kind: "aiStore", messageId: m.id };
    }
  }

  // 3) 连 assistant 消息都没有（极罕见）：退回到最新一条消息
  if (conv.messages.length > 0) {
    return { kind: "aiStore", messageId: conv.messages[conv.messages.length - 1]!.id };
  }

  return null;
}

function persistForm(form: UserQuestionFormData, parent: ParentRef): void {
  if (parent?.kind === "blocksStore") {
    useBlocksStore
      .getState()
      .upsertAiThreadUserQuestionPart(parent.blockId, parent.messageId, form);
  } else if (parent?.kind === "aiStore") {
    useAiStore
      .getState()
      .upsertStreamUserQuestion(form.conversationId, parent.messageId, form);
  }
  // 同步到 OSS 聊天分片，供小程序端渲染澄清表单（无活跃录制时 no-op）
  appendChatOssEvent({ t: "ask_user", form });
}

/** 从 ParentRef 拉取当前所有 user-question parts（用于 supersede 逻辑） */
function collectPendingForms(
  conversationId: string,
  parent: ParentRef,
): Array<{ form: UserQuestionFormData; messageId: string }> {
  if (parent?.kind === "blocksStore") {
    const block = useBlocksStore.getState().findBlockById(parent.blockId);
    if (!block?.aiThread) return [];
    const result: Array<{ form: UserQuestionFormData; messageId: string }> = [];
    for (const item of block.aiThread) {
      if (item.kind !== "message") continue;
      const parts = item.parts ?? [];
      for (const part of parts) {
        if (part.type !== "user-question") continue;
        if (part.form.status !== "pending") continue;
        result.push({ form: part.form, messageId: item.id });
      }
    }
    return result;
  }
  if (parent?.kind === "aiStore") {
    const conv = useAiStore.getState().conversations.find((c) => c.id === conversationId);
    if (!conv) return [];
    const result: Array<{ form: UserQuestionFormData; messageId: string }> = [];
    for (const msg of conv.messages) {
      const parts = msg.parts ?? [];
      for (const part of parts) {
        if (part.type !== "user-question") continue;
        if (part.form.status !== "pending") continue;
        result.push({ form: part.form, messageId: msg.id });
      }
    }
    return result;
  }
  return [];
}

/** 将同会话其它 pending 表单标为 superseded 并回传 skipped */
async function supersedePendingForms(
  conversationId: string,
  exceptToolCallId: string,
  parent: ParentRef,
): Promise<void> {
  const pendingForms = collectPendingForms(conversationId, parent);

  for (const { form } of pendingForms) {
    if (form.toolCallId === exceptToolCallId) continue;
    if (resolvedToolCallIds.has(form.toolCallId)) continue;

    const next: UserQuestionFormData = {
      ...form,
      status: "superseded",
      updatedAt: Date.now(),
    };
    persistForm(next, parent);

    resolvedToolCallIds.add(form.toolCallId);
    await reportToolResultWithRetry(
      conversationId,
      form.toolCallId,
      serializeAskUserResult("skipped", {}),
      true,
    ).catch(() => {});
  }
}

/**
 * 挂起工具入口：校验入参 → 写 part → 等待用户（不立即回传）。
 */
export async function dispatchAskUserTool(options: AskUserDispatchOptions): Promise<void> {
  const { conversationId, toolCallId, argsJson, inline } = options;

  if (resolvedToolCallIds.has(toolCallId)) {
    return;
  }

  const parsed = parseAskUserArgs(argsJson);
  if (!parsed.ok) {
    await reportToolResultWithRetry(conversationId, toolCallId, parsed.error, false);
    resolvedToolCallIds.add(toolCallId);
    return;
  }

  const parent = findParentMessage(conversationId, toolCallId, inline);
  if (!parent) {
    await reportToolResultWithRetry(
      conversationId,
      toolCallId,
      `找不到包含 toolCallId ${toolCallId} 的父消息`,
      false,
    );
    resolvedToolCallIds.add(toolCallId);
    return;
  }

  await supersedePendingForms(conversationId, toolCallId, parent);

  const form: UserQuestionFormData = {
    formId: genFormId(),
    toolCallId,
    conversationId,
    title: parsed.title,
    questions: parsed.questions,
    status: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  persistForm(form, parent);

  // 直通 Shell Agent：挂起询问卡
  if (conversationId.startsWith("term-inline:")) {
    const sessionId = conversationId.slice("term-inline:".length);
    if (sessionId) {
      void import("../../../modules/terminal/shellAgent/loop").then(({ notifyShellAgentAskPending }) => {
        notifyShellAgentAskPending(sessionId, form.formId);
      });
    }
  }
}

async function resolveForm(
  formId: string,
  status: "answered" | "skipped",
  answers?: Record<string, AskUserAnswerValue>,
): Promise<void> {
  // 先在 aiStore 里查
  let found:
    | {
        conversationId: string;
        parent: ParentRef;
        form: UserQuestionFormData;
      }
    | null = null;

  // 1) aiStore
  for (const conv of useAiStore.getState().conversations) {
    for (const msg of conv.messages) {
      const part = msg.parts?.find(
        (p) => p.type === "user-question" && p.form.formId === formId,
      );
      if (part && part.type === "user-question") {
        found = {
          conversationId: conv.id,
          parent: { kind: "aiStore", messageId: msg.id },
          form: part.form,
        };
        break;
      }
    }
    if (found) break;
  }

  // 2) blocksStore
  if (!found) {
    outer: for (const blocks of Object.values(useBlocksStore.getState().blocks)) {
      for (const block of blocks) {
        if (!block.aiThread) continue;
        for (const item of block.aiThread) {
          if (item.kind !== "message") continue;
          const part = item.parts?.find(
            (p) => p.type === "user-question" && p.form.formId === formId,
          );
          if (part && part.type === "user-question") {
            found = {
              conversationId: part.form.conversationId,
              parent: { kind: "blocksStore", messageId: item.id, blockId: block.id },
              form: part.form,
            };
            break outer;
          }
        }
      }
    }
  }

  if (!found) return;
  if (found.form.status !== "pending") return;
  if (resolvedToolCallIds.has(found.form.toolCallId)) return;

  if (status === "answered") {
    const err = validateAskUserAnswers(found.form.questions, answers ?? {});
    if (err) {
      throw new Error(err);
    }
  }

  const next: UserQuestionFormData = {
    ...found.form,
    status,
    answers: status === "answered" ? answers : found.form.answers,
    updatedAt: Date.now(),
  };

  // 直通：必须在 persistForm 之前同步冻结。
  // 否则 React 先切到紧凑 AnswerSummary，冻结快照被压矮，占位却仍是高表单高度。
  if (found.conversationId.startsWith("term-inline:")) {
    const sessionId = found.conversationId.slice("term-inline:".length);
    if (sessionId) {
      notifyShellAgentAskResolved(sessionId);
    }
  }

  persistForm(next, found.parent);
  resolvedToolCallIds.add(found.form.toolCallId);

  await reportToolResultWithRetry(
    found.conversationId,
    found.form.toolCallId,
    serializeAskUserResult(status, status === "answered" ? answers : {}),
    true,
  );
}

export async function submitAskUserAnswers(
  formId: string,
  answers: Record<string, AskUserAnswerValue>,
): Promise<void> {
  await resolveForm(formId, "answered", answers);
}

export async function skipAskUserForm(formId: string): Promise<void> {
  await resolveForm(formId, "skipped");
}
