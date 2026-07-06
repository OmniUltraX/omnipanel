import { streamOpenAI, type ModelConfig } from "../assistant-ui/chatModel";

export type SimpleChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface RunSimpleChatOptions {
  signal?: AbortSignal;
  /** 终端环境上下文块（由 buildTerminalAiContextAppend 生成），注入到 system prompt */
  terminalContextAppend?: string | null;
}

function buildApiMessages(
  systemPrompt: string,
  userContent: string | SimpleChatContentPart[],
  terminalContextAppend?: string | null,
) {
  const messages: { role: "system" | "user" | "assistant"; content: string }[] =
    [];

  const systemParts: string[] = [];
  if (systemPrompt) {
    systemParts.push(systemPrompt);
  }
  if (terminalContextAppend?.trim()) {
    systemParts.push(terminalContextAppend);
  }
  if (systemParts.length > 0) {
    messages.push({ role: "system", content: systemParts.join("\n\n") });
  }

  if (typeof userContent === "string") {
    messages.push({ role: "user", content: userContent });
  } else {
    const textParts = userContent
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    messages.push({ role: "user", content: textParts || "(image)" });
  }
  return messages;
}

/** 单次 LLM 调用（无 Agent / 工具），用于简单结构化任务。 */
export async function runSimpleChat(
  modelConfig: ModelConfig,
  systemPrompt: string,
  userContent: string | SimpleChatContentPart[],
  options?: RunSimpleChatOptions,
): Promise<string> {
  const messages = buildApiMessages(
    systemPrompt,
    userContent,
    options?.terminalContextAppend,
  );

  let result = "";
  for await (const chunk of streamOpenAI(messages, modelConfig, [], {
    signal: options?.signal,
  })) {
    if (chunk.type === "text") {
      result += chunk.delta;
    }
  }

  return result.trim();
}
