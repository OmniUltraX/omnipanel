/** 工具调用状态（侧栏 / 终端桥共用） */
export interface ToolCallState {
  id: string;
  name: string;
  arguments: string;
  result?: string;
  status: "pending" | "running" | "completed" | "failed";
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
    };

/** 从 parts 派生兼容字段 */
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
