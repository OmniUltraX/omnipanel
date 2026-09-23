/**
 * OpenCode `question.asked` / `form.created` → OmniPanel UserQuestionForm。
 *
 * - question：`POST .../question/{id}/reply`，答案为 label[][]
 * - form：`POST .../form/{id}/reply`，答案为 `{ [fieldKey]: value }`
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
  value?: unknown;
};

type OpenCodeQuestionInfo = {
  question?: unknown;
  header?: unknown;
  options?: unknown;
  multiple?: unknown;
  custom?: unknown;
  key?: unknown;
  fieldType?: unknown;
};

function asTrimmedString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** 将 OpenCode Question.Info[] / Form.Field 映射结果转为 AskUserQuestion[] */
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
    const fieldKey = asTrimmedString(raw.key);
    const fieldType = asTrimmedString(raw.fieldType);
    const optRaw = Array.isArray(raw.options) ? raw.options : [];
    const options: AskUserOption[] = [];
    const seen = new Set<string>();
    for (let j = 0; j < optRaw.length; j++) {
      const o = optRaw[j] as OpenCodeQuestionOption | null;
      if (!o || typeof o !== "object") continue;
      const label = asTrimmedString(o.label);
      const value = asTrimmedString(o.value) || label;
      if (!label && !value) continue;
      // form reply 用 option.value；question reply 用 label。id 优先 value。
      let id = value || label;
      if (seen.has(id)) id = `${id}__${j}`;
      seen.add(id);
      const description = asTrimmedString(o.description) || undefined;
      options.push({
        id,
        label: label || value,
        ...(description ? { description } : {}),
      });
    }

    let type: AskUserQuestion["type"];
    if (fieldType === "multiselect" || multiple) {
      type = options.length > 0 ? "multi_choice" : "text";
    } else if (options.length === 0) {
      type = "text";
    } else {
      type = "single_choice";
    }

    questions.push({
      id: fieldKey || `q${i}`,
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

/** 内部答案 → OpenCode question `string[][]`（按题序，值为 label / 自定义文本） */
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

/**
 * 内部答案 → OpenCode form `{ [fieldKey]: value }`。
 * 选项值用 option.id（即 Form.Option.value）；boolean 字段转 bool。
 */
export function toOpenCodeFormAnswer(
  questions: AskUserQuestion[],
  answers: Record<string, AskUserAnswerValue>,
): Record<string, string | number | boolean | string[]> {
  const out: Record<string, string | number | boolean | string[]> = {};
  for (const q of questions) {
    const v = answers[q.id];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      const vals = v
        .map((id) => {
          const opt = q.options?.find((o) => o.id === id);
          return (opt?.id ?? id).trim();
        })
        .filter(Boolean);
      if (vals.length) out[q.id] = vals;
      continue;
    }
    if (typeof v !== "string" || !v.trim()) continue;
    const raw = v.trim();
    // boolean 字段：选项 id 为 "true"/"false"
    if (raw === "true" || raw === "false") {
      const looksBool =
        q.options?.length === 2 &&
        q.options.every((o) => o.id === "true" || o.id === "false");
      if (looksBool) {
        out[q.id] = raw === "true";
        continue;
      }
    }
    // 数字文本框：尽量解析为 number
    if (q.type === "text" && /^-?\d+(\.\d+)?$/.test(raw)) {
      const n = Number(raw);
      if (Number.isFinite(n)) {
        out[q.id] = n;
        continue;
      }
    }
    const asOpt = q.options?.find((o) => o.id === raw || o.label === raw);
    out[q.id] = asOpt?.id ?? raw;
  }
  return out;
}

export type PresentOpenCodeQuestionOpts = {
  conversationId: string;
  /** 当前流式 assistant 消息 id；侧边栏必填 */
  messageId: string | null;
  requestId: string;
  sessionId: string;
  questionsJson: string;
  /** question（旧）| form（V2） */
  kind?: string | null;
  title?: string | null;
  inline?: { blockId: string; assistantTurnId: string } | null;
};

/** 将 OpenCode 提问写入当前 assistant 消息的 user-question part */
export function presentOpenCodeQuestion(opts: PresentOpenCodeQuestionOpts): void {
  const questions = mapOpenCodeQuestions(opts.questionsJson);
  if (questions.length === 0) return;

  const sessionId = (opts.sessionId || opts.conversationId).trim();
  const requestId = opts.requestId.trim();
  if (!requestId) return;

  const kindRaw = (opts.kind || "").trim().toLowerCase();
  const kind: "question" | "form" =
    kindRaw === "form" || requestId.startsWith("frm_") ? "form" : "question";

  const now = Date.now();
  const form: UserQuestionFormData = {
    formId: `opencode:${requestId}`,
    toolCallId: requestId,
    conversationId: opts.conversationId,
    title:
      (opts.title || "").trim() ||
      (questions.length === 1 ? questions[0]!.prompt : "请确认"),
    questions,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    source: "opencode",
    opencodeSessionId: sessionId || opts.conversationId,
    opencodeKind: kind,
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

  const kind =
    form.opencodeKind === "form" || requestId.startsWith("frm_")
      ? "form"
      : "question";

  if (kind === "form") {
    if (status === "answered") {
      const answer = toOpenCodeFormAnswer(form.questions, answers ?? {});
      await unwrapCommand(
        commands.opencodeReplyForm(sessionId, requestId, answer),
      );
    } else {
      await unwrapCommand(commands.opencodeCancelForm(sessionId, requestId));
    }
    return;
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
