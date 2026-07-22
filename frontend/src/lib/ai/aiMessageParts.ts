/** 工具调用状态（侧栏 / 终端桥共用） */
export interface ToolCallState {
  id: string;
  name: string;
  arguments: string;
  result?: string;
  status: "pending" | "running" | "completed" | "failed";
}

/** 计划步骤状态 */
export type PlanStepStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";

/** 计划步骤：AI 自主规划的任务步骤 */
export interface PlanStep {
  id: string;
  title: string;
  status: PlanStepStatus;
  /** 关联的工具调用 ID（步骤执行时对应的 tool-call part） */
  toolCallId?: string;
  /** 工具名提示（如 ssh_exec / database_execute_sql） */
  toolName?: string;
  /** 步骤摘要（执行后填充） */
  summary?: string;
  /** 错误信息（失败时填充） */
  error?: string;
}

/** 计划：AI 多步骤任务计划 */
export interface PlanData {
  id: string;
  title: string;
  steps: PlanStep[];
  /** 整体状态 */
  status: "planning" | "executing" | "completed" | "failed" | "cancelled";
  createdAt: number;
  updatedAt: number;
}

/** 有序消息片段：流式按到达顺序追加，供 UI 交错渲染 */
export type AiMessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool-call";
      id: string;
      name: string;
      arguments: string;
      result?: string;
      status: ToolCallState["status"];
    }
  | {
      type: "plan";
      plan: PlanData;
    };

/** 从 parts 派生兼容字段（plan 类型不参与派生，仅 UI 渲染） */
export function deriveCompatFields(parts: AiMessagePart[]): {
  content: string;
  reasoningContent?: string;
  toolCalls?: ToolCallState[];
} {
  let content = "";
  let reasoning = "";
  const toolCalls: ToolCallState[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      content += part.text;
    } else if (part.type === "reasoning") {
      reasoning += part.text;
    } else if (part.type === "tool-call") {
      toolCalls.push({
        id: part.id,
        name: part.name,
        arguments: part.arguments,
        result: part.result,
        status: part.status,
      });
    }
    // plan 类型跳过：不参与 content/reasoning/toolCalls 派生
  }
  return {
    content,
    reasoningContent: reasoning || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

/** 扁平字段 → 有序 parts（旧会话 migrate / 无 parts 时） */
export function partsFromFlatFields(msg: {
  content?: string;
  reasoningContent?: string;
  toolCalls?: ToolCallState[];
  parts?: AiMessagePart[];
}): AiMessagePart[] {
  if (Array.isArray(msg.parts) && msg.parts.length > 0) {
    return msg.parts;
  }
  const parts: AiMessagePart[] = [];
  if (msg.reasoningContent) {
    parts.push({ type: "reasoning", text: msg.reasoningContent });
  }
  if (msg.content) {
    parts.push({ type: "text", text: msg.content });
  }
  for (const tc of msg.toolCalls ?? []) {
    parts.push({
      type: "tool-call",
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
      result: tc.result,
      status: tc.status,
    });
  }
  return parts;
}

export function appendTextLikePart(
  parts: AiMessagePart[],
  kind: "text" | "reasoning",
  chunk: string,
): AiMessagePart[] {
  if (!chunk) return parts;
  const next = [...parts];
  const last = next[next.length - 1];
  if (last && last.type === kind) {
    next[next.length - 1] = { ...last, text: last.text + chunk };
  } else {
    next.push({ type: kind, text: chunk });
  }
  return next;
}

export function upsertToolCallInParts(
  parts: AiMessagePart[],
  id: string,
  name: string,
  args: string,
): AiMessagePart[] {
  const idx = parts.findIndex((p) => p.type === "tool-call" && p.id === id);
  if (idx >= 0) {
    const existing = parts[idx] as Extract<AiMessagePart, { type: "tool-call" }>;
    const next = [...parts];
    next[idx] = { ...existing, name, arguments: args };
    return next;
  }
  return [
    ...parts,
    { type: "tool-call", id, name, arguments: args, status: "running" },
  ];
}

export function updateToolCallInParts(
  parts: AiMessagePart[],
  id: string,
  status: ToolCallState["status"],
  result?: string,
): AiMessagePart[] {
  return parts.map((part) => {
    if (part.type !== "tool-call" || part.id !== id) return part;
    return {
      ...part,
      status,
      ...(result !== undefined ? { result } : {}),
    };
  });
}

/**
 * 更新或插入 plan part。
 * 如果已存在同 planId 的 plan part，替换其数据；否则追加新 plan part。
 */
export function upsertPlanInParts(
  parts: AiMessagePart[],
  plan: PlanData,
): AiMessagePart[] {
  const idx = parts.findIndex((p) => p.type === "plan" && p.plan.id === plan.id);
  if (idx >= 0) {
    const next = [...parts];
    next[idx] = { type: "plan", plan: { ...plan, updatedAt: Date.now() } };
    return next;
  }
  return [...parts, { type: "plan", plan }];
}

/**
 * 更新 plan 中的某个步骤（按 stepId 匹配）。
 * 如果找不到对应的 plan part 或 step，返回原 parts 不变。
 */
export function updatePlanStepInParts(
  parts: AiMessagePart[],
  planId: string,
  stepId: string,
  patch: Partial<PlanStep>,
): AiMessagePart[] {
  return parts.map((part) => {
    if (part.type !== "plan" || part.plan.id !== planId) return part;
    return {
      ...part,
      plan: {
        ...part.plan,
        updatedAt: Date.now(),
        steps: part.plan.steps.map((s) =>
          s.id === stepId ? { ...s, ...patch } : s,
        ),
      },
    };
  });
}

/**
 * 向 plan 追加新步骤（在指定 stepId 之后插入；不指定则追加到末尾）。
 */
export function addPlanStepInParts(
  parts: AiMessagePart[],
  planId: string,
  step: PlanStep,
  afterStepId?: string,
): AiMessagePart[] {
  return parts.map((part) => {
    if (part.type !== "plan" || part.plan.id !== planId) return part;
    const steps = [...part.plan.steps];
    if (afterStepId) {
      const idx = steps.findIndex((s) => s.id === afterStepId);
      if (idx >= 0) {
        steps.splice(idx + 1, 0, step);
      } else {
        steps.push(step);
      }
    } else {
      steps.push(step);
    }
    return {
      ...part,
      plan: { ...part.plan, steps, updatedAt: Date.now() },
    };
  });
}
