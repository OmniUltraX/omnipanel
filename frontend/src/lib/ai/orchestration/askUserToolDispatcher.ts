/**
 * omni_ask_user dispatcher：结构化澄清表单。
 *
 * 数据流：
 * 1. AI 调用 → 后端挂起 → dispatchPendingTool 拦截 → 本 dispatcher 写 user-question part
 * 2. 用户提交/跳过 → aiChatToolResult 回传 → 会话续跑
 * 3. 同会话新的 ask_user 会 supersede 旧 pending 表单
 */
import { useAiStore } from "../../../stores/aiStore";
import { reportToolResultWithRetry } from "../reportToolResult";
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
};

const resolvedToolCallIds = new Set<string>();

let formSeq = 0;
function genFormId(): string {
  return `ask_${Date.now()}_${(++formSeq).toString(36)}`;
}

function findParentMessage(conversationId: string, toolCallId: string) {
  const conv = useAiStore.getState().conversations.find((c) => c.id === conversationId);
  if (!conv) return null;
  const msg = conv.messages.find(
    (m) =>
      Array.isArray(m.parts) &&
      m.parts.some((p) => p.type === "tool-call" && p.id === toolCallId),
  );
  if (!msg) return null;
  return { conv, msg };
}

function persistForm(form: UserQuestionFormData, messageId: string): void {
  useAiStore.getState().upsertStreamUserQuestion(form.conversationId, messageId, form);
}

/** 将同会话其它 pending 表单标为 superseded 并回传 skipped */
async function supersedePendingForms(
  conversationId: string,
  exceptToolCallId: string,
): Promise<void> {
  const conv = useAiStore.getState().conversations.find((c) => c.id === conversationId);
  if (!conv) return;

  for (const msg of conv.messages) {
    const parts = msg.parts ?? [];
    for (const part of parts) {
      if (part.type !== "user-question") continue;
      if (part.form.status !== "pending") continue;
      if (part.form.toolCallId === exceptToolCallId) continue;
      if (resolvedToolCallIds.has(part.form.toolCallId)) continue;

      const next: UserQuestionFormData = {
        ...part.form,
        status: "superseded",
        updatedAt: Date.now(),
      };
      useAiStore.getState().upsertStreamUserQuestion(conversationId, msg.id, next);

      resolvedToolCallIds.add(part.form.toolCallId);
      await reportToolResultWithRetry(
        conversationId,
        part.form.toolCallId,
        serializeAskUserResult("skipped", {}),
        true,
      ).catch(() => {});
    }
  }
}

/**
 * 挂起工具入口：校验入参 → 写 part → 等待用户（不立即回传）。
 */
export async function dispatchAskUserTool(options: AskUserDispatchOptions): Promise<void> {
  const { conversationId, toolCallId, argsJson } = options;

  if (resolvedToolCallIds.has(toolCallId)) {
    return;
  }

  const parsed = parseAskUserArgs(argsJson);
  if (!parsed.ok) {
    await reportToolResultWithRetry(conversationId, toolCallId, parsed.error, false);
    resolvedToolCallIds.add(toolCallId);
    return;
  }

  const parent = findParentMessage(conversationId, toolCallId);
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

  await supersedePendingForms(conversationId, toolCallId);

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

  persistForm(form, parent.msg.id);
}

async function resolveForm(
  formId: string,
  status: "answered" | "skipped",
  answers?: Record<string, AskUserAnswerValue>,
): Promise<void> {
  const store = useAiStore.getState();
  let found: { conversationId: string; messageId: string; form: UserQuestionFormData } | null =
    null;

  for (const conv of store.conversations) {
    for (const msg of conv.messages) {
      const part = msg.parts?.find(
        (p) => p.type === "user-question" && p.form.formId === formId,
      );
      if (part && part.type === "user-question") {
        found = {
          conversationId: conv.id,
          messageId: msg.id,
          form: part.form,
        };
        break;
      }
    }
    if (found) break;
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

  persistForm(next, found.messageId);
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
