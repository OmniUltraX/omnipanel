/**
 * OpenCode `question.asked` → OmniPanel UserQuestionForm。
 *
 * 答案回传：`POST /api/session/{session}/question/{request}/reply`，
 * 每题一组 **label**（或自定义文本），不是 option index。
 */
import { commands } from "../../../ipc/bindings";
import { unwrapCommand } from "../../../ipc/result";
import { useAiStore } from "../../../stores/aiStore";
import { useBlocksStore } from "../../../stores/blocksStore";
import { appendChatOssEvent } from "../chatOssRecorder";
import type {
  AskUserAnswerValue,
  AskUserOption,
  AskUserQuestion,
  UserQuestionFormData,
} from "../aiMessageParts";

type OpenCodeQuestionOption = {
  label?: unknown;
  description?: unknown;
};

type OpenCodeQuestionInfo = {
  question?: unknown;
  header?: unknown;
  options?: unknown;
  multiple?: unknown;
  custom?: unknown;
};

function asTrimmedString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** 将 OpenCode Question.Info[] 映射为内部 AskUserQuestion[] */
export function mapOpenCodeQuestions(rawJson: string): AskUserQuestion[] {
  let arr: unknown;
  try {
    arr = JSON.parse(rawJson || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(arr) || arr.length === 0) return [];

  const questions: AskUserQuestion[] = [];
  for (let i = 0; i < arr.length; i++) {
    const raw = arr[i] as OpenCodeQuestionInfo | null;
    if (!raw || typeof raw !== "object") continue;
    const prompt =
      asTrimmedString(raw.question) ||
      asTrimmedString(raw.header) ||
      `问题 ${i + 1}`;
    const multiple = raw.multiple === true;
    // OpenCode 默认 custom=true
    const allowCustom = raw.custom !== false;
    const optRaw = Array.isArray(raw.options) ? raw.options : [];
    const options: AskUserOption[] = [];
    const seen = new Set<string>();
    for (let j = 0; j < optRaw.length; j++) {
      const o = optRaw[j] as OpenCodeQuestionOption | null;
      if (!o || typeof o !== "object") continue;
      const label = asTrimmedString(o.label);
      if (!label) continue;
      // reply API 要 label：id 与 label 对齐
      let id = label;
      if (seen.has(id)) id = `${label}__${j}`;
      seen.add(id);
      const description = asTrimmedString(o.description) || undefined;
      options.push({ id, label, ...(description ? { description } : {}) });
    }

    let type: AskUserQuestion["type"];
    if (options.length === 0) {
      type = "text";
    } else if (multiple) {
      type = "multi_choice";
    } else {
      type = "single_choice";
    }

    questions.push({
      id: `q${i}`,
      prompt,
      type,
      ...(options.length > 0 ? { options } : {}),
      required: true,
      allowCustom: type !== "text" ? allowCustom : undefined,
      ...(type === "text"
        ? { placeholder: asTrimmedString(raw.header) || "请输入…" }
        : {}),
    });
  }
  return questions;
}

/** 内部答案 → OpenCode `string[][]`（按题序，值为 label / 自定义文本） */
export function toOpenCodeAnswers(
  questions: AskUserQuestion[],
  answers: Record<string, AskUserAnswerValue>,
): string[][] {
  return questions.map((q) => {
    const v = answers[q.id];
    if (Array.isArray(v)) {
      return v
        .map((id) => q.options?.find((o) => o.id === id)?.label ?? id)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (typeof v === "string" && v.trim()) {
      if (q.type === "text" || q.allowCustom) {
        const asOpt = q.options?.find((o) => o.id === v);
        return [asOpt?.label ?? v.trim()];
      }
      const asOpt = q.options?.find((o) => o.id === v);
      return [asOpt?.label ?? v.trim()];
    }
    return [];
  });
}

export type PresentOpenCodeQuestionOpts = {
  conversationId: string;
  /** 当前流式 assistant 消息 id；侧边栏必填 */
  messageId: string | null;
  requestId: string;
  sessionId: string;
  questionsJson: string;
  inline?: { blockId: string; assistantTurnId: string } | null;
};

/** 将 OpenCode 提问写入当前 assistant 消息的 user-question part */
export function presentOpenCodeQuestion(opts: PresentOpenCodeQuestionOpts): void {
  const questions = mapOpenCodeQuestions(opts.questionsJson);
  if (questions.length === 0) return;

  const sessionId = (opts.sessionId || opts.conversationId).trim();
  const requestId = opts.requestId.trim();
  if (!requestId) return;

  const now = Date.now();
  const form: UserQuestionFormData = {
    formId: `opencode:${requestId}`,
    toolCallId: requestId,
    conversationId: opts.conversationId,
    title: questions.length === 1 ? questions[0]!.prompt : "请确认",
    questions,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    source: "opencode",
    opencodeSessionId: sessionId || opts.conversationId,
  };

  appendChatOssEvent({ t: "ask_user", form });

  if (opts.inline?.assistantTurnId) {
    useBlocksStore
      .getState()
      .upsertAiThreadUserQuestionPart(
        opts.inline.blockId,
        opts.inline.assistantTurnId,
        form,
      );
    return;
  }

  if (opts.messageId) {
    useAiStore
      .getState()
      .upsertStreamUserQuestion(opts.conversationId, opts.messageId, form);
  }
}

/** 提交 / 跳过 OpenCode 提问（不走 tool result） */
export async function resolveOpenCodeQuestion(
  form: UserQuestionFormData,
  status: "answered" | "skipped",
  answers?: Record<string, AskUserAnswerValue>,
): Promise<void> {
  const sessionId = (form.opencodeSessionId || form.conversationId).trim();
  const requestId = form.toolCallId.trim();
  if (!sessionId || !requestId) {
    throw new Error("OpenCode 提问缺少 session/request id");
  }

  if (status === "answered") {
    const payload = toOpenCodeAnswers(form.questions, answers ?? {});
    await unwrapCommand(
      commands.opencodeReplyQuestion(sessionId, requestId, payload),
    );
  } else {
    await unwrapCommand(commands.opencodeRejectQuestion(sessionId, requestId));
  }
}
