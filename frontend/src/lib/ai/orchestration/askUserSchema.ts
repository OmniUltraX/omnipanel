import type {
  AskUserAnswerValue,
  AskUserOption,
  AskUserQuestion,
  AskUserQuestionType,
} from "../aiMessageParts";

function parseArgs<T>(argsJson: string): T | null {
  try {
    return JSON.parse(argsJson || "{}") as T;
  } catch {
    return null;
  }
}

function isQuestionType(v: unknown): v is AskUserQuestionType {
  return v === "single_choice" || v === "multi_choice" || v === "text";
}

/** 校验并规范化入参；失败返回错误文案 */
export function parseAskUserArgs(argsJson: string):
  | { ok: true; title?: string; questions: AskUserQuestion[] }
  | { ok: false; error: string } {
  const args = parseArgs<{ title?: unknown; questions?: unknown }>(argsJson);
  if (!args) {
    return { ok: false, error: "参数解析失败：无效 JSON" };
  }

  const title =
    typeof args.title === "string" && args.title.trim()
      ? args.title.trim()
      : undefined;

  if (!Array.isArray(args.questions) || args.questions.length === 0) {
    return { ok: false, error: "参数解析失败：questions 必须是非空数组" };
  }
  if (args.questions.length > 5) {
    return { ok: false, error: "参数解析失败：questions 最多 5 题" };
  }

  const questions: AskUserQuestion[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < args.questions.length; i++) {
    const raw = args.questions[i];
    if (!raw || typeof raw !== "object") {
      return { ok: false, error: `参数解析失败：questions[${i}] 必须是对象` };
    }
    const obj = raw as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id.trim() : "";
    const prompt = typeof obj.prompt === "string" ? obj.prompt.trim() : "";
    if (!id) {
      return { ok: false, error: `参数解析失败：questions[${i}].id 必须是非空字符串` };
    }
    if (seenIds.has(id)) {
      return { ok: false, error: `参数解析失败：questions[].id 重复：${id}` };
    }
    seenIds.add(id);
    if (!prompt) {
      return {
        ok: false,
        error: `参数解析失败：questions[${i}].prompt 必须是非空字符串`,
      };
    }
    if (!isQuestionType(obj.type)) {
      return {
        ok: false,
        error: `参数解析失败：questions[${i}].type 必须是 single_choice | multi_choice | text`,
      };
    }

    let options: AskUserOption[] | undefined;
    if (obj.type === "single_choice" || obj.type === "multi_choice") {
      if (!Array.isArray(obj.options) || obj.options.length < 2) {
        return {
          ok: false,
          error: `参数解析失败：questions[${i}].options 至少 2 项`,
        };
      }
      options = [];
      const optIds = new Set<string>();
      for (let j = 0; j < obj.options.length; j++) {
        const o = obj.options[j];
        if (!o || typeof o !== "object") {
          return {
            ok: false,
            error: `参数解析失败：questions[${i}].options[${j}] 必须是对象`,
          };
        }
        const oo = o as Record<string, unknown>;
        const oid = typeof oo.id === "string" ? oo.id.trim() : "";
        const label = typeof oo.label === "string" ? oo.label.trim() : "";
        if (!oid || !label) {
          return {
            ok: false,
            error: `参数解析失败：questions[${i}].options[${j}] 需要非空 id/label`,
          };
        }
        if (optIds.has(oid)) {
          return {
            ok: false,
            error: `参数解析失败：questions[${i}].options[].id 重复：${oid}`,
          };
        }
        optIds.add(oid);
        options.push({ id: oid, label });
      }
    }

    const required = obj.required === false ? false : true;
    const placeholder =
      typeof obj.placeholder === "string" && obj.placeholder.trim()
        ? obj.placeholder.trim()
        : undefined;

    questions.push({
      id,
      prompt,
      type: obj.type,
      ...(options ? { options } : {}),
      required,
      ...(placeholder ? { placeholder } : {}),
    });
  }

  return { ok: true, title, questions };
}

/** 校验答案是否满足必填与题型约束 */
export function validateAskUserAnswers(
  questions: AskUserQuestion[],
  answers: Record<string, AskUserAnswerValue>,
): string | null {
  for (const q of questions) {
    if (q.required === false) continue;
    const v = answers[q.id];
    if (q.type === "multi_choice") {
      if (!Array.isArray(v) || v.length === 0) {
        return `请完成必填题：${q.prompt}`;
      }
    } else if (typeof v !== "string" || !v.trim()) {
      return `请完成必填题：${q.prompt}`;
    }
  }
  return null;
}

export function serializeAskUserResult(
  status: "answered" | "skipped",
  answers?: Record<string, AskUserAnswerValue>,
): string {
  return JSON.stringify(
    {
      ok: true,
      status,
      answers: answers ?? {},
    },
    null,
    2,
  );
}
