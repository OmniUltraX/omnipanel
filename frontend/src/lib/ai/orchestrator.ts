import { Channel, invoke } from "@tauri-apps/api/core";

import type { AcpStreamEvent, EmbeddingProviderConfig } from "../../ipc/bindings";
import { commands } from "../../ipc/bindings";
import { isTauriRuntime } from "../isTauriRuntime";

import type { HttpProviderSnapshot } from "./inferenceBackend";

/** 内部聊天流事件：在 Acp 事件基础上补齐 Usage（ai_chat_stream 直传 StreamEvent） */
export type InternalStreamEvent =
  | AcpStreamEvent
  | { type: "usage"; input_tokens: number; output_tokens: number };

export interface AiContextBundle {
  cwd?: string | null;
  workspaceId?: string | null;
  terminalSessionId?: string | null;
  terminalSessionType?: "local" | "remote" | null;
  envTag?: string | null;
  resourceId?: string | null;
  terminalContextAppend?: string | null;
  moduleContextAppend?: string | null;
}

export interface InternalChatRequestPayload {
  conversationId: string;
  userText: string;
  backendId: string;
  context: AiContextBundle;
  historyJson?: string | null;
  toolsMode?: "none" | { directInject: { moduleFilter?: string | null } };
  httpProvider?: HttpProviderSnapshot | null;
  /** 知识库 RAG 自动注入用的 embedding provider 配置；null 跳过 RAG */
  embeddingProvider?: EmbeddingProviderConfig | null;
  /**
   * 纯文本补全模式（oneshot：会话命名、历史摘要等）。
   * 为 true 时后端跳过工具注入 / RAG / Skills / 多轮循环，prompt_text 直接用 userText。
   * 默认 undefined（后端按 false 处理，向后兼容）。
   */
  pureText?: boolean;
  /** 会话勾选的 Skill id；非空时后端注入完整正文 */
  skillIds?: string[] | null;
  /** 推理强度：default | low | medium | high */
  reasoningEffort?: string | null;
}

export interface RunInternalAiChatOptions {
  request: InternalChatRequestPayload;
  signal?: AbortSignal;
  onEvent: (event: InternalStreamEvent) => void;
}

export async function runInternalAiChat(options: RunInternalAiChatOptions): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error("Internal AI 需要在 Tauri 桌面环境中运行");
  }

  const onEvent = new Channel<InternalStreamEvent>();
  onEvent.onmessage = (event) => {
    options.onEvent(event);
  };

  const abortListener = () => {
    void commands.aiChatCancel(options.request.conversationId).catch(() => {});
  };
  options.signal?.addEventListener("abort", abortListener);

  const toolsMode =
    options.request.toolsMode === undefined || options.request.toolsMode === "none"
      ? "none"
      : {
          directInject: {
            moduleFilter: options.request.toolsMode.directInject.moduleFilter ?? null,
          },
        };

  try {
    await invoke("ai_chat_stream", {
      request: {
        conversationId: options.request.conversationId,
        userText: options.request.userText,
        backendId: options.request.backendId,
        context: {
          cwd: options.request.context.cwd ?? null,
          workspaceId: options.request.context.workspaceId ?? null,
          terminalSessionId: options.request.context.terminalSessionId ?? null,
          terminalSessionType: options.request.context.terminalSessionType ?? null,
          envTag: options.request.context.envTag ?? null,
          resourceId: options.request.context.resourceId ?? null,
          terminalContextAppend: options.request.context.terminalContextAppend ?? null,
          moduleContextAppend: options.request.context.moduleContextAppend ?? null,
        },
        historyJson: options.request.historyJson ?? null,
        toolsMode,
        httpProvider: options.request.httpProvider
          ? {
              providerId: options.request.httpProvider.providerId,
              apiStandard: options.request.httpProvider.apiStandard,
              baseUrl: options.request.httpProvider.baseUrl,
              apiKey: options.request.httpProvider.apiKey,
            }
          : null,
        embeddingProvider: options.request.embeddingProvider
          ? {
              providerId: options.request.embeddingProvider.providerId,
              modelName: options.request.embeddingProvider.modelName.trim(),
              baseUrl: options.request.embeddingProvider.baseUrl.trim(),
              apiKey: options.request.embeddingProvider.apiKey.trim(),
              apiStandard: options.request.embeddingProvider.apiStandard,
            }
          : null,
        pureText: options.request.pureText ?? false,
        skillIds:
          options.request.skillIds && options.request.skillIds.length > 0
            ? options.request.skillIds
            : null,
        reasoningEffort: options.request.reasoningEffort ?? null,
      },
      onEvent,
    });
  } finally {
    options.signal?.removeEventListener("abort", abortListener);
  }
}
