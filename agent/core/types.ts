import type { DeepAgent } from "deepagents";
import type { BaseMessage } from "@langchain/core/messages";

/** 核心层统一的 Agent 流式事件，适配器负责转换为各协议格式。 */
export type AgentStreamEvent =
  | { type: "content_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | {
      type: "tool_call_update";
      id: string;
      status: "completed" | "failed";
      result?: string;
    };

export type AgentTurnContext = {
  sessionId: string;
  messages: BaseMessage[];
  graph: DeepAgent;
};

export type AgentTurnHandlers = {
  onEvent: (event: AgentStreamEvent) => void | Promise<void>;
  signal: AbortSignal;
};
