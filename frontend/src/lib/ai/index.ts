/**
 * `lib/ai` 公开入口：App 内推理只暴露内置编排与 oneshot。
 * Agent Router / OmniMCP 的端口与配置同步也从这里 re-export。
 *
 * 不要从本 barrel 再导出 `runSimpleChat` / `streamOpenAI` 等前端 SSE 直连；
 * 那些是第四条推理路径，已 @deprecated。
 */

export {
  runInternalAiChat,
  type AiContextBundle,
  type InternalChatRequestPayload,
  type InternalStreamEvent,
  type RunInternalAiChatOptions,
} from "./orchestrator";

export {
  requestAiCompletionOnce,
  AI_COMPLETION_ONCE_TIMEOUT_MS,
  AI_COMPLETION_ONCE_RETRY_DELAY_MS,
  AI_COMPLETION_ONCE_MAX_RETRIES,
  type AiCompletionOnceResult,
  type RequestAiCompletionOnceOptions,
} from "./requestAiCompletionOnce";

export {
  submitAiPrompt,
  registerAiPromptSubmit,
  AiPromptBusyError,
  type InlineTerminalAiTarget,
  type SubmitAiPromptOptions,
} from "./submitAiPrompt";

export { syncGatewayConfig } from "./gatewayConfig";

export {
  RELEASE_GATEWAY_PORT,
  DEV_GATEWAY_PORT,
  RELEASE_OMNIMCP_PORT,
  DEV_OMNIMCP_PORT,
  DEFAULT_GATEWAY_PORT,
  OMNIMCP_BUILTIN_MCP_PORT,
  OMNIMCP_BUILTIN_MCP_URL,
  resolveGatewayListenPort,
  isBuiltinOmniMcpUrl,
} from "./localServicePorts";
