import { commands } from "../../ipc/bindings";
import type { AssistantConversationSnapshotItem } from "../../ipc/bindings";
import { unwrapCommand, formatIpcError } from "../../ipc/result";
import { useAuthStore } from "../../stores/authStore";
import { useAiStore, type AiConversation } from "../../stores/aiStore";

const DEBOUNCE_MS = 5000;
/** 与后端 ASSISTANT_CONVERSATION_SNAPSHOT_LIMIT 对齐 */
const CONVERSATION_SNAPSHOT_LIMIT = 50;

let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
let pendingAfterFlight = false;
let lastBindId: string | null = null;

/** 取消尚未发出的自动同步（登出时调用）。 */
export function cancelAssistantSnapshotSync(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  pendingAfterFlight = false;
}

/**
 * 模块元数据变更后调度自动上传（debounce）。
 * 未登录时静默跳过；进行中再变更会排队一次。
 */
export function scheduleAssistantSnapshotSync(options?: {
  bindId?: string | null;
  /** 跳过 debounce，尽快推一次（绑定成功等） */
  immediate?: boolean;
}): void {
  if (options?.bindId !== undefined) {
    lastBindId = options.bindId;
  }

  const token = useAuthStore.getState().token;
  if (!token?.trim()) {
    return;
  }

  if (options?.immediate) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    void runPush();
    return;
  }

  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void runPush();
  }, DEBOUNCE_MS);
}

/** 将会话转为快照条目（不含 messages）。 */
export function toAssistantConversationSnapshotItem(
  conv: AiConversation,
): AssistantConversationSnapshotItem {
  return {
    id: conv.id,
    title: conv.title,
    provider: conv.provider,
    model: conv.model,
    modelSelectionId: conv.modelSelectionId ?? null,
    agentId: conv.agentId ?? null,
    messageCount: conv.messages.length,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    parentConversationId: conv.parentConversationId ?? null,
    rootConversationId: conv.rootConversationId ?? null,
    pinnedWorkspaceId: conv.pinnedWorkspaceId ?? null,
    linkedTerminalSessionId: conv.linkedTerminalSessionId ?? null,
  };
}

/** 取最近更新的会话列表元数据，供推送注入。 */
export function collectAssistantConversationSnapshots(): AssistantConversationSnapshotItem[] {
  const list = [...useAiStore.getState().conversations];
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  return list.slice(0, CONVERSATION_SNAPSHOT_LIMIT).map(toAssistantConversationSnapshotItem);
}

async function runPush(): Promise<void> {
  const token = useAuthStore.getState().token;
  if (!token?.trim()) {
    return;
  }

  if (inFlight) {
    pendingAfterFlight = true;
    return;
  }

  inFlight = (async () => {
    try {
      await unwrapCommand(
        commands.assistantPushSnapshot({
          token,
          dryRun: false,
          bindId: lastBindId,
          conversations: collectAssistantConversationSnapshots(),
        }),
        { quiet: true },
      );
    } catch (err) {
      // 自动同步失败不打断主流程；控制台留痕便于联调
      console.warn("[assistant-auto-sync]", formatIpcError(err));
    } finally {
      inFlight = null;
      if (pendingAfterFlight) {
        pendingAfterFlight = false;
        scheduleAssistantSnapshotSync();
      }
    }
  })();

  await inFlight;
}
