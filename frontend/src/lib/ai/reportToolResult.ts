import { commands } from "../../ipc/bindings";

/** 回传工具结果；短重试以覆盖 oneshot 尚未注册或 IPC 瞬断。 */
export async function reportToolResultWithRetry(
  conversationId: string,
  toolCallId: string,
  result: string,
  approved: boolean,
): Promise<void> {
  const delaysMs = [0, 40, 120, 300, 800, 2000, 5000];
  let lastError: unknown;
  for (const delay of delaysMs) {
    if (delay > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, delay));
    }
    try {
      await commands.aiChatToolResult(conversationId, toolCallId, result, approved);
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
