/**
 * OmniPanel 本地 Agent — DeepAgents + Skills + MCP + ACP stdio
 *
 * 协议：https://agentclientprotocol.com/protocol/v1/overview
 * 在 OmniPanel「ACP 服务」中配置可执行文件：`node --import tsx /path/to/agent/index.ts`
 */
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AgentContext,
  type ContentBlock,
  type SessionId,
  type ToolCallId,
} from "@agentclientprotocol/sdk";
import { AIMessage, AIMessageChunk, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import {
  createSessionRuntime,
  disposeSessionRuntime,
  type SessionRuntime,
} from "./agent-runtime.js";

type ActivePrompt = {
  abort: AbortController;
};

type SessionRecord = SessionRuntime & {
  messages: BaseMessage[];
  activePrompt: ActivePrompt | null;
};

const sessions = new Map<SessionId, SessionRecord>();

function log(...args: unknown[]): void {
  console.error("[omniagent]", ...args);
}

function promptBlocksToText(blocks: ContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === "text") {
        return block.text;
      }
      if (block.type === "resource_link") {
        return `[资源链接 ${block.name ?? block.uri}]`;
      }
      if (block.type === "resource") {
        return `[内嵌资源 ${block.resource.uri ?? ""}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

async function notifyAgentChunk(
  client: AgentContext,
  sessionId: SessionId,
  text: string,
  messageId: string,
): Promise<void> {
  if (!text) return;
  await client.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
      messageId,
    },
  });
}

async function notifyToolCall(
  client: AgentContext,
  sessionId: SessionId,
  toolCallId: ToolCallId,
  title: string,
  rawInput: unknown,
): Promise<void> {
  await client.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: "tool_call",
      toolCallId,
      title,
      kind: "other",
      status: "in_progress",
      rawInput,
    },
  });
}

async function notifyToolResult(
  client: AgentContext,
  sessionId: SessionId,
  toolCallId: ToolCallId,
  title: string,
  rawOutput: unknown,
  failed: boolean,
): Promise<void> {
  await client.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId,
      title,
      status: failed ? "failed" : "completed",
      rawOutput,
    },
  });
}

async function requestToolPermission(
  client: AgentContext,
  sessionId: SessionId,
  toolCallId: ToolCallId,
  title: string,
  rawInput: unknown,
): Promise<boolean> {
  try {
    const response = await client.request(methods.client.session.requestPermission, {
      sessionId,
      toolCall: {
        toolCallId,
        title,
        status: "pending",
        rawInput,
      },
      options: [
        { optionId: "allow_once", name: "允许一次", kind: "allow_once" },
        { optionId: "reject_once", name: "拒绝", kind: "reject_once" },
      ],
    });

    if (response.outcome.outcome === "cancelled") {
      return false;
    }
    return response.outcome.optionId === "allow_once" || response.outcome.optionId === "allow_always";
  } catch (error) {
    log("权限请求失败，默认拒绝:", error);
    return false;
  }
}

type ToolCallTracker = {
  toolCallId: ToolCallId;
  title: string;
};

async function runDeepAgentTurn(
  record: SessionRecord,
  userText: string,
  client: AgentContext,
  signal: AbortSignal,
): Promise<void> {
  const messageId = randomUUID();
  record.messages.push(new HumanMessage(userText));
  const pendingTools = new Map<string, ToolCallTracker>();
  let assistantReply = "";

  const stream = record.graph.streamEvents(
    { messages: record.messages },
    {
      version: "v2",
      configurable: { thread_id: record.sessionId },
    },
  );

  for await (const event of stream) {
    if (signal.aborted) {
      throw new DOMException("Prompt cancelled", "AbortError");
    }

    if (event.event === "on_chat_model_stream") {
      const chunk = event.data?.chunk;
      if (chunk instanceof AIMessageChunk) {
        const text =
          typeof chunk.content === "string"
            ? chunk.content
            : Array.isArray(chunk.content)
              ? chunk.content
                  .map((part) => (typeof part === "string" ? part : part.type === "text" ? part.text : ""))
                  .join("")
              : "";
        if (text) {
          assistantReply += text;
          await notifyAgentChunk(client, record.sessionId, text, messageId);
        }
      }
      continue;
    }

    if (event.event === "on_tool_start") {
      const toolCallId = randomUUID();
      const title = event.name ?? "tool";
      const rawInput = event.data?.input ?? {};
      const runId = typeof event.run_id === "string" ? event.run_id : randomUUID();
      pendingTools.set(runId, { toolCallId, title });

      await notifyToolCall(client, record.sessionId, toolCallId, title, rawInput);
      // DeepAgents 在事件触发前已开始执行工具，此处仅通知客户端；完整拦截需 middleware 钩子。
      void requestToolPermission(client, record.sessionId, toolCallId, title, rawInput);
      continue;
    }

    if (event.event === "on_tool_end") {
      const runId = typeof event.run_id === "string" ? event.run_id : "";
      const tracked = runId ? pendingTools.get(runId) : undefined;
      if (runId) pendingTools.delete(runId);

      const toolCallId = tracked?.toolCallId ?? randomUUID();
      const title = tracked?.title ?? event.name ?? "tool";
      const rawOutput = event.data?.output;
      const failed = Boolean(event.data?.error);
      await notifyToolResult(client, record.sessionId, toolCallId, title, rawOutput, failed);
    }
  }

  try {
    const state = (await record.graph.getState({
      configurable: { thread_id: record.sessionId },
    })) as { values?: { messages?: BaseMessage[] } };
    if (state.values?.messages) {
      record.messages = state.values.messages;
      return;
    }
  } catch (error) {
    log("同步会话消息失败，使用流式结果回退:", error);
  }

  if (assistantReply.trim()) {
    record.messages.push(new AIMessage(assistantReply));
  }
}

function startAcpServer(): void {
  const app = agent({ name: "omniagent" })
    .onRequest(methods.agent.initialize, async () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: {
        name: "omniagent",
        version: "1.0.0",
      },
      agentCapabilities: {
        promptCapabilities: {
          text: true,
          image: false,
          audio: false,
          embeddedContext: false,
        },
        mcpCapabilities: {
          http: true,
          sse: true,
          stdio: true,
        },
      },
      authMethods: [],
    }))
    .onRequest(methods.agent.session.new, async ({ params }) => {
      const sessionId = randomUUID();
      const cwd = params.cwd;

      const runtime = await createSessionRuntime(sessionId, cwd);
      sessions.set(sessionId, {
        ...runtime,
        messages: [],
        activePrompt: null,
      });

      log("session/new", sessionId, "cwd=", cwd);

      return { sessionId };
    })
    .onRequest(methods.agent.session.prompt, async ({ params, client, signal }) => {
      const record = sessions.get(params.sessionId);
      if (!record) {
        throw new Error(`未知 session: ${params.sessionId}`);
      }

      const userText = promptBlocksToText(params.prompt);
      if (!userText.trim()) {
        return { stopReason: "end_turn" as const };
      }

      const abort = new AbortController();
      record.activePrompt = { abort };

      const onAbort = () => abort.abort();
      signal.addEventListener("abort", onAbort, { once: true });

      try {
        await runDeepAgentTurn(record, userText, client, abort.signal);
        return { stopReason: "end_turn" as const };
      } catch (error) {
        if (abort.signal.aborted || signal.aborted) {
          return { stopReason: "cancelled" as const };
        }
        const message = error instanceof Error ? error.message : String(error);
        log("prompt error:", message);
        await notifyAgentChunk(client, params.sessionId, `\n\n错误: ${message}`, randomUUID());
        return { stopReason: "refusal" as const };
      } finally {
        signal.removeEventListener("abort", onAbort);
        record.activePrompt = null;
      }
    })
    .onNotification(methods.agent.session.cancel, async ({ params }) => {
      const record = sessions.get(params.sessionId);
      record?.activePrompt?.abort.abort();
      log("session/cancel", params.sessionId);
    })
    .onRequest(methods.agent.session.close, async ({ params }) => {
      const record = sessions.get(params.sessionId);
      if (record) {
        record.activePrompt?.abort.abort();
        await disposeSessionRuntime(record);
        sessions.delete(params.sessionId);
      }
      return {};
    });

  const rawStdout = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  const rawStdin = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;

  const stream = ndJsonStream(rawStdout, rawStdin);

  app.connect(stream);
  log("ACP stdio 服务已启动 (protocol", PROTOCOL_VERSION, ")");
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entryHref) {
  startAcpServer();
}
