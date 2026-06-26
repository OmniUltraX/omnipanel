import type { ApiStandard } from "../../../stores/aiModelsStore";
import type { ModuleKey } from "../../../lib/paths";
import { buildApiKeyHeader, buildBearerAuthorization, fetchWithNetworkHint } from "../../../lib/fetchHeaders";
import { isTauriRuntime } from "../../../lib/isTauriRuntime";
import { streamPostViaTauri } from "../../../lib/tauriHttpStream";

export type StreamChunk =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | {
      type: "tool-call-delta";
      index: number;
      id?: string;
      name?: string;
      argsDelta: string;
    };

export type ToolCallResult = {
  id: string;
  name: string;
  args: string;
};

export interface ModelConfig {
  apiStandard: ApiStandard;
  name: string;
  baseUrl: string;
  apiKey: string;
}

export interface ApiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCallResult[];
  name?: string;
}

export interface ReasoningEffortOption {
  type: "reasoning_effort";
  reasoning_effort: "low" | "medium" | "high";
}

export interface AiToolDef {
  serviceId: string;
  originalName: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  kind: "external" | "module";
  moduleKey?: ModuleKey;
}

function buildOpenAiTools(tools: AiToolDef[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.originalName,
      description: tool.description,
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
    },
  }));
}

function buildAnthropicTools(tools: AiToolDef[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    name: tool.originalName,
    description: tool.description,
    input_schema: tool.inputSchema ?? { type: "object", properties: {} },
  }));
}

async function openStreamingResponseBody(
  url: string,
  headers: Record<string, string>,
  body: string,
  signal?: AbortSignal,
): Promise<AsyncIterable<string>> {
  if (isTauriRuntime()) {
    return streamPostViaTauri(url, headers, body, { signal, timeoutMs: 120_000 });
  }

  const response = await fetchWithNetworkHint(url, {
    method: "POST",
    headers,
    body,
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`API error ${response.status}: ${errorText || response.statusText}`);
  }

  if (!response.body) {
    throw new Error("响应体为空");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  async function* fromFetch(): AsyncGenerator<string> {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
  }

  return fromFetch();
}

async function* parseOpenAiSseStream(chunks: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  let buffer = "";

  for await (const chunk of chunks) {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") return;

      try {
        const parsed = JSON.parse(data);
        const choice = parsed.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;
        if (!delta) continue;

        if (delta.content) {
          yield { type: "text" as const, delta: delta.content };
        }

        if (delta.reasoning_content) {
          yield { type: "reasoning" as const, delta: delta.reasoning_content };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            yield {
              type: "tool-call-delta" as const,
              index: tc.index ?? 0,
              id: tc.id,
              name: tc.function?.name,
              argsDelta: tc.function?.arguments ?? "",
            };
          }
        }
      } catch {
        /* skip malformed JSON lines */
      }
    }
  }
}

export async function* streamOpenAI(
  messages: ApiMessage[],
  config: ModelConfig,
  tools: AiToolDef[],
  options?: { signal?: AbortSignal; reasoningEffort?: string },
): AsyncGenerator<StreamChunk> {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const url = baseUrl.includes("/v1") ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;

  const body: Record<string, unknown> = {
    model: config.name,
    messages: toOpenAiWireMessages(messages),
    stream: true,
    stream_options: { include_usage: true },
  };

  if (options?.reasoningEffort && options.reasoningEffort !== "default") {
    body.reasoning_effort = options.reasoningEffort;
  }

  if (tools.length > 0) {
    body.tools = buildOpenAiTools(tools);
    body.tool_choice = "auto";
  }

  const responseBody = await openStreamingResponseBody(
    url,
    {
      "Content-Type": "application/json",
      Authorization: buildBearerAuthorization(config.apiKey),
    },
    JSON.stringify(body),
    options?.signal,
  );

  yield* parseOpenAiSseStream(responseBody);
}

export async function* streamAnthropic(
  messages: ApiMessage[],
  config: ModelConfig,
  tools: AiToolDef[],
  options?: { signal?: AbortSignal },
): AsyncGenerator<StreamChunk> {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/v1/messages`;

  const body: Record<string, unknown> = {
    model: config.name,
    messages: messages.filter((m) => m.role !== "system"),
    system: messages.find((m) => m.role === "system")?.content,
    stream: true,
    max_tokens: 4096,
  };

  const anthropicTools = tools.length > 0 ? buildAnthropicTools(tools) : getAnthropicTools(messages);
  if (anthropicTools.length > 0) {
    body.tools = anthropicTools;
  }

  const responseBody = await openStreamingResponseBody(
    url,
    {
      "Content-Type": "application/json",
      "x-api-key": buildApiKeyHeader(config.apiKey),
      "anthropic-version": "2023-06-01",
    },
    JSON.stringify(body),
    options?.signal,
  );

  let buffer = "";
  for await (const chunk of responseBody) {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);

      try {
        const parsed = JSON.parse(data);
        if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
          yield { type: "text" as const, delta: parsed.delta.text };
        }
        if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use") {
          const cb = parsed.content_block;
          yield {
            type: "tool-call-delta" as const,
            index: parsed.index ?? 0,
            id: cb.id,
            name: cb.name,
            argsDelta: JSON.stringify(cb.input ?? {}),
          };
        }
        if (parsed.type === "content_block_delta" && parsed.delta?.type === "input_json_delta") {
          yield {
            type: "tool-call-delta" as const,
            index: parsed.index ?? 0,
            argsDelta: parsed.delta.partial_json,
          };
        }
      } catch {
        /* skip */
      }
    }
  }
}

function getAnthropicTools(messages: ApiMessage[]): Record<string, unknown>[] {
  const seenNames = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        seenNames.add(tc.name);
      }
    }
  }
  return Array.from(seenNames).map((name) => ({
    name,
    description: `Tool: ${name}`,
    input_schema: { type: "object", properties: {} },
  }));
}

export type BuildModelMessageInput = {
  role: string;
  content: string;
  toolCalls?: {
    id: string;
    name: string;
    arguments: string;
    result?: string;
  }[];
};

function toOpenAiWireMessages(messages: ApiMessage[]): Record<string, unknown>[] {
  return messages.map((msg) => {
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      return {
        role: "assistant",
        content: msg.content || null,
        tool_calls: msg.tool_calls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments: tc.args,
          },
        })),
      };
    }
    if (msg.role === "tool") {
      return {
        role: "tool",
        content: msg.content,
        tool_call_id: msg.tool_call_id,
        name: msg.name,
      };
    }
    return { role: msg.role, content: msg.content };
  });
}

export function buildModelMessages(
  messages: BuildModelMessageInput[],
  tools: AiToolDef[],
  options?: { moduleContextText?: string | null },
): { apiMessages: ApiMessage[]; tools: AiToolDef[] } {
  const apiMessages: ApiMessage[] = [];
  const systemParts: string[] = [];

  systemParts.push(`You are OmniPanel AI assistant, an all-in-one DevOps tool.`);
  if (options?.moduleContextText) {
    systemParts.push(`\n${options.moduleContextText}`);
  }
  if (tools.length > 0) {
    systemParts.push(
      `\nYou have access to tools. When the user asks a question that requires real-time data, prefer using tools to get accurate information.`,
    );
    const toolDescriptions = tools
      .map((tool) => {
        const prefix = tool.kind === "module" ? `[模块:${tool.moduleKey}]` : `[MCP:${tool.serviceId}]`;
        return `- ${prefix} ${tool.originalName}: ${tool.description}`;
      })
      .join("\n");
    systemParts.push(`\nAvailable tools:\n${toolDescriptions}`);
  }

  if (systemParts.length > 0) {
    apiMessages.push({ role: "system", content: systemParts.join("\n") });
  }

  for (const msg of messages) {
    if (msg.role === "system") continue;
    if (msg.role === "user") {
      apiMessages.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      const entry: ApiMessage = { role: "assistant", content: msg.content };
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        entry.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          args: tc.arguments,
        }));
      }
      apiMessages.push(entry);
      for (const tc of msg.toolCalls ?? []) {
        if (tc.result !== undefined) {
          apiMessages.push({
            role: "tool",
            content: tc.result,
            tool_call_id: tc.id,
            name: tc.name,
          });
        }
      }
    } else if (msg.role === "tool") {
      const tc = msg.toolCalls?.[0];
      if (!tc?.id || !tc.name) continue;
      apiMessages.push({
        role: "tool",
        content: msg.content,
        tool_call_id: tc.id,
        name: tc.name,
      });
    }
  }

  return { apiMessages, tools };
}

export async function* streamModelChat(
  apiMessages: ApiMessage[],
  config: ModelConfig,
  tools: AiToolDef[],
  options?: { signal?: AbortSignal; reasoningEffort?: string },
): AsyncGenerator<StreamChunk> {
  if (config.apiStandard === "anthropic") {
    yield* streamAnthropic(apiMessages, config, tools, options);
  } else {
    yield* streamOpenAI(apiMessages, config, tools, options);
  }
}

export function mergeToolCallDeltas(
  acc: Map<number, { id?: string; name?: string; args: string }>,
  deltas: { index: number; id?: string; name?: string; argsDelta: string }[],
): { id: string; name: string; args: string }[] {
  for (const d of deltas) {
    const current = acc.get(d.index) ?? { args: "" };
    if (d.id) {
      if (current.id && current.id !== d.id) {
        current.args = "";
      }
      current.id = d.id;
    }
    if (d.name) current.name = d.name;

    const delta = d.argsDelta;
    if (delta) {
      const existing = current.args.trim();
      if (existing && delta.trim().startsWith("{")) {
        try {
          JSON.parse(existing);
          current.args = delta;
        } catch {
          current.args += delta;
        }
      } else {
        current.args += delta;
      }
    }

    acc.set(d.index, current);
  }

  const result: { id: string; name: string; args: string }[] = [];
  for (const [, v] of acc) {
    if (v.id && v.name) {
      result.push({ id: v.id, name: v.name, args: v.args || "{}" });
    }
  }
  return result;
}

export async function* streamSimpleChat(
  config: ModelConfig,
  systemPrompt: string,
  userContent: string,
  options?: { signal?: AbortSignal },
): AsyncGenerator<string> {
  const messages: ApiMessage[] = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: userContent });

  for await (const chunk of streamOpenAI(messages, config, [], options)) {
    if (chunk.type === "text") {
      yield chunk.delta;
    }
  }
}
