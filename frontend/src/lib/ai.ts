import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ─── Types aligned with Rust IR ───

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "error";
export type ToolStatus = "pending" | "running" | "completed" | "failed";

export type StreamEvent =
  | { type: "content_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "tool_call_update"; id: string; status: ToolStatus }
  | { type: "usage"; input_tokens: number; output_tokens: number }
  | { type: "done"; stop_reason: StopReason }
  | { type: "error"; message: string };

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  context_window?: number;
}

export interface ProviderInfo {
  id: string;
  name: string;
  models: ModelInfo[];
}

// ─── API ───

export const aiApi = {
  /** Send a message and receive streaming events via callback */
  async sendMessage(
    conversationId: string,
    content: string,
    onEvent: (event: StreamEvent) => void
  ): Promise<void> {
    // Listen for streamed events on the conversation channel
    const unlisten = await listen<StreamEvent>(
      `ai-stream-${conversationId}`,
      (event) => {
        onEvent(event.payload);
      }
    );

    try {
      await invoke("ai_send_message", {
        conversationId,
        content,
      });
    } finally {
      unlisten();
    }
  },

  /** List all available models */
  async listModels(): Promise<ModelInfo[]> {
    return invoke("ai_list_models");
  },

  /** Set the active provider and model */
  async setProvider(providerId: string, modelId: string): Promise<void> {
    return invoke("ai_set_provider", { providerId, modelId });
  },

  /** List all registered providers */
  async listProviders(): Promise<ProviderInfo[]> {
    return invoke("ai_list_providers");
  },

  /** Register an ACP CLI agent as a provider */
  async addAcpAgent(binaryPath: string, name: string): Promise<void> {
    return invoke("ai_add_acp_agent", { binaryPath, name });
  },

  /** Get current active provider/model */
  async getActive(): Promise<[string, string] | null> {
    return invoke("ai_get_active");
  },

  /** Listen for stream events from a specific conversation */
  onStreamEvent(
    conversationId: string,
    callback: (event: StreamEvent) => void
  ): Promise<UnlistenFn> {
    return listen<StreamEvent>(
      `ai-stream-${conversationId}`,
      (event) => callback(event.payload)
    );
  },
};
