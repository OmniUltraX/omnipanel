import { commands } from "../../ipc/bindings";

import type {

  AssistantAiModelSnapshotItem,

  AssistantConversationSnapshotItem,

  AssistantTerminalSessionSnapshotItem,

} from "../../ipc/bindings";

import { unwrapCommand, formatIpcError } from "../../ipc/result";

import { useAuthStore } from "../../stores/authStore";

import { useAiStore, type AiConversation } from "../../stores/aiStore";

import {

  buildModelSelectionId,

  isModelEnabled,

  useAiModelsStore,

} from "../../stores/aiModelsStore";

import { useTerminalStore } from "../../stores/terminalStore";



const DEBOUNCE_MS = 5000;

/** 与后端 ASSISTANT_CONVERSATION_SNAPSHOT_LIMIT 对齐 */

const CONVERSATION_SNAPSHOT_LIMIT = 50;

const TERMINAL_SESSION_SNAPSHOT_LIMIT = 50;



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



/** 终端会话快照（不含 PTY 输出；与 AI 会话分离）。 */

export function collectTerminalSessionSnapshots(): AssistantTerminalSessionSnapshotItem[] {

  const state = useTerminalStore.getState();

  const list = state.sessions.filter((s) => s.lifecycle !== "ended");

  list.sort((a, b) => b.lastActiveAt - a.lastActiveAt);

  return list.slice(0, TERMINAL_SESSION_SNAPSHOT_LIMIT).map((s) => {

    const tab = state.tabs.find((t) => t.sessionId === s.id);

    const detached = state.detachedRuntime[s.id];

    const status = tab?.status || detached?.status || "disconnected";

    return {

      id: s.id,

      title: s.title,

      sessionType: s.session.type === "remote" ? "remote" : "local",

      resourceId: s.session.resourceId || "",

      shellLabel: s.session.shellLabel || "",

      cwd: s.session.cwd || "",

      lifecycle: s.lifecycle,

      status: String(status || "disconnected"),

      createdAt: s.createdAt,

      updatedAt: s.lastActiveAt,

    };

  });

}



/** AI 模型目录快照（含禁用项；不含 API Key / baseUrl）。 */

export function collectAiModelSnapshots(): AssistantAiModelSnapshotItem[] {

  const providers = useAiModelsStore.getState().providers;

  const items: AssistantAiModelSnapshotItem[] = [];

  for (const provider of providers) {

    for (const modelName of provider.modelNames) {

      items.push({

        id: buildModelSelectionId(provider.id, modelName),

        providerId: provider.id,

        providerName: provider.providerName,

        modelName,

        apiStandard: provider.apiStandard,

        enabled: isModelEnabled(provider, modelName),

      });

    }

  }

  return items;

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

          terminalSessions: collectTerminalSessionSnapshots(),

          aiModels: collectAiModelSnapshots(),

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

