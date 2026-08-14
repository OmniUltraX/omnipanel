import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { createIndexedDBStorage } from "../lib/indexedDbStorage";
import type { WorkspaceContextSnapshot } from "./workspaceStore";
import { useWorkspaceStore } from "./workspaceStore";
import {
  parseModelSelectionId,
  resolveModelSelection,
  useAiModelsStore,
} from "./aiModelsStore";
import { useSettingsStore } from "./settingsStore";
import { resolveScenarioModelSelectionId } from "../lib/aiScenarioModels";
import {
  appendTextLikePart,
  deriveCompatFields,
  partsFromFlatFields,
  updateToolCallInParts,
  upsertPlanInParts,
  upsertUserQuestionInParts,
  upsertToolCallInParts,
  upsertClusterInParts,
  updateClusterChildInParts,
  updateClusterStatusInParts,
  type AiMessagePart,
  type PlanData,
  type ToolCallState,
  type SubConversationChildState,
  type SubConversationClusterPartData,
  type SubConversationClusterStatus,
  type UserQuestionFormData,
} from "../lib/ai/aiMessageParts";
import {
  ASSISTANT_PAGE_AGENT_ID,
  isAgentId,
  type AgentId,
} from "../lib/ai/agents";
import { recordConversationTombstones } from "../modules/clientSync/tombstones";

/**
 * 会话列表结构变更后：
 * 1) 助手端脱敏快照（device 路径）
 * 2) 客户端间会话同步（账号级 sync/ 路径）
 * 两套逻辑独立；动态 import 避免与 autoSync 环依赖。
 */
function scheduleConversationListSnapshotSync(options?: {
  immediate?: boolean;
  /** 本次删除的会话 id（写入 client-sync tombstone） */
  deletedIds?: string[];
}): void {
  if (options?.deletedIds?.length) {
    recordConversationTombstones(options.deletedIds);
  }
  void import("../modules/assistant").then((m) => {
    m.scheduleAssistantSnapshotSync(options);
  });
  void import("../modules/clientSync").then((m) => {
    m.scheduleClientConversationSync();
  });
}

export type {
  AiMessagePart,
  PlanData,
  ToolCallState,
  SubConversationChildState,
  SubConversationClusterPartData,
  SubConversationClusterStatus,
  SubConversationSpawnSpec,
  UserQuestionFormData,
  AskUserQuestion,
  AskUserAnswerValue,
} from "../lib/ai/aiMessageParts";
export {
  coalescePartsByToolSegments,
  coalescePartsForCoherentDisplay,
  coalesceToolsInThinkingPhases,
  deriveCompatFields,
  partsFromFlatFields,
  stripLeakedToolCallsJson,
  upsertClusterInParts,
  upsertUserQuestionInParts,
  updateClusterChildInParts,
  updateClusterStatusInParts,
} from "../lib/ai/aiMessageParts";

export interface AgentMcpConnection {
  serviceId: string;
  serviceName: string;
  builtin: boolean;
  toolCount: number;
}

/** 单次请求的 token 用量（来自上游 Usage 事件） */
export interface AiTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** 流式性能计时（供 MessageTiming / 状态条） */
export interface AiMessageTiming {
  streamStartTime: number;
  firstTokenTime?: number;
  totalStreamTime?: number;
  totalChunks?: number;
}

export interface AiMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  /** 权威有序片段；缺省时由扁平字段 migrate */
  parts?: AiMessagePart[];
  content: string;
  /** 推理模型返回的思考过程（兼容：reasoning parts 拼接） */
  reasoningContent?: string;
  timestamp: number;
  /** 兼容：从 tool-call parts 派生 */
  toolCalls?: ToolCallState[];
  isStreaming?: boolean;
  isReasoningStreaming?: boolean;
  /** 本条 assistant 回复对应的 token 用量 */
  usage?: AiTokenUsage;
  /** 本条流式计时 */
  timing?: AiMessageTiming;
}

/** 规范化消息：确保 parts 存在并与兼容字段一致 */
export function normalizeAiMessage(msg: AiMessage): AiMessage {
  const parts = partsFromFlatFields(msg);
  const compat = deriveCompatFields(parts);
  return { ...msg, parts, ...compat };
}

function withUpdatedParts(msg: AiMessage, parts: AiMessagePart[], extra?: Partial<AiMessage>): AiMessage {
  const compat = deriveCompatFields(parts);
  return { ...msg, parts, ...compat, ...extra };
}

/** 推理强度（OpenAI / DeepSeek 等兼容 API 的 reasoning_effort） */
export type ReasoningEffortLevel = "default" | "low" | "medium" | "high";

/** 会话列表展示位置 */
export type ConversationListPlacement = "dropdown" | "right";

export interface AiConversation {
  id: string;
  title: string;
  messages: AiMessage[];
  provider: string;
  model: string;
  /** 当前会话选用的模型（aiModelsStore selectionId 或 cli/acp backend id） */
  modelSelectionId?: string | null;
  /** 当前会话勾选的 Skill id 列表 */
  selectedSkillIds?: string[];
  /**
   * 绑定的逻辑 Agent（chat / 各模块）。
   * 助手页会话固定为 chat；模块内联等场景绑定对应模块 Agent。
   */
  agentId?: AgentId;
  createdAt: number;
  updatedAt: number;
  context?: { type: string; label: string }[];
  contextSnapshot?: WorkspaceContextSnapshot;
  /** 显式钉住的工作区（可选；null/undefined=全局作用域） */
  pinnedWorkspaceId?: string | null;
  /** 附着的终端 session（Dock ↔ 终端互通） */
  linkedTerminalSessionId?: string | null;
  /** 由内联 AI Promote 而来的源 block */
  sourceBlockId?: string | null;
  /**
   * 子会话父关系（cursor sub-agent 范式）：
   * - null/undefined = 根会话（普通会话）
   * - 字符串 = 子会话，值为父会话 id
   * 子会话不在会话列表显示，仅能从父会话的 cluster 卡片进入。
   */
  parentConversationId?: string | null;
  /** 根会话 id（方便聚合查询；根会话时等于自身 id） */
  rootConversationId?: string;
  /** 从父会话哪个消息派生（assistant message id） */
  spawnedFromMessageId?: string;
  /** 属于哪个子会话集群（clusterId，对应 SubConversationClusterPart.clusterId） */
  spawnedFromClusterId?: string;
  /** 在集群中的索引（0-based，用于显示与排序） */
  indexInCluster?: number;
}

interface AiStore {
  conversations: AiConversation[];
  activeConversationId: string | null;
  drawerOpen: boolean;
  currentProvider: string;
  currentModel: string;
  /** aiModelsStore 中的 providerId::modelName */
  currentModelSelectionId: string | null;
  /** 无活动会话时的草稿 Skill 选择 */
  currentSkillIds: string[];
  isGenerating: boolean;
  draftPrompt: string;
  /** 推理程度，default 表示不传给 API */
  reasoningEffort: ReasoningEffortLevel;
  /** 当前智能体已连接的 MCP 服务（打开助手或发送消息时刷新） */
  connectedMcpServices: AgentMcpConnection[];
  /** 右侧会话列表面板是否展开 */
  conversationListOpen: boolean;
  /** 会话列表展示位置：下拉菜单 / 右侧边栏 */
  conversationListPlacement: ConversationListPlacement;
  /** 会话列表面板宽度（px） */
  conversationListWidth: number;
  /**
   * 子会话查看模式：非 null 时 Thread 切换为该子会话视图。
   * 切换为 null 返回主会话（activeConversationId）。
   * 子会话视图下输入框禁用、仅可查看历史。
   */
  viewingChildConversationId: string | null;

  toggleDrawer: () => void;
  openDrawer: () => void;
  closeDrawer: () => void;
  createConversation: (
    provider?: string,
    model?: string,
    options?: { agentId?: AgentId },
  ) => string;
  /**
   * 确保存在指定 id 的会话：已有则激活；不存在则以该 id 新建（助手端入站路由用）。
   */
  ensureConversationId: (
    id: string,
    options?: { agentId?: AgentId },
  ) => string;
  setConversationAgentId: (conversationId: string, agentId: AgentId) => void;
  setActiveConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  deleteConversation: (id: string) => void;
  addMessage: (
    conversationId: string,
    msg: Omit<AiMessage, "id" | "timestamp">
  ) => string;
  updateMessage: (
    conversationId: string,
    messageId: string,
    update: Partial<AiMessage>
  ) => void;
  appendStreamContent: (
    conversationId: string,
    messageId: string,
    chunk: string
  ) => void;
  appendStreamReasoning: (
    conversationId: string,
    messageId: string,
    chunk: string
  ) => void;
  /** 流式 upsert tool-call part（同 id 更新，否则按序追加） */
  upsertStreamToolCall: (
    conversationId: string,
    messageId: string,
    id: string,
    name: string,
    args: string,
  ) => void;
  /** 流式更新 tool-call part 的 status/result */
  updateStreamToolCall: (
    conversationId: string,
    messageId: string,
    id: string,
    status: ToolCallState["status"],
    result?: string,
  ) => void;
  /** 流式 upsert plan part（同 planId 更新，否则追加） */
  upsertStreamPlan: (
    conversationId: string,
    messageId: string,
    plan: PlanData,
  ) => void;
  /** 流式 upsert user-question part（同 formId 更新，否则追加） */
  upsertStreamUserQuestion: (
    conversationId: string,
    messageId: string,
    form: UserQuestionFormData,
  ) => void;
  /** 流式 upsert sub-conversation-cluster part（同 clusterId 更新，否则追加） */
  upsertStreamCluster: (
    conversationId: string,
    messageId: string,
    cluster: SubConversationClusterPartData,
  ) => void;
  /** 流式更新 cluster 中单个 child 状态 */
  updateStreamClusterChild: (
    conversationId: string,
    messageId: string,
    clusterId: string,
    childConversationId: string,
    patch: Partial<SubConversationChildState>,
  ) => void;
  /** 流式更新 cluster 整体状态 */
  setStreamClusterStatus: (
    conversationId: string,
    messageId: string,
    clusterId: string,
    status: SubConversationClusterStatus,
    aggregatedResult?: string,
  ) => void;
  setCurrentProvider: (provider: string, model: string) => void;
  setCurrentModelSelectionId: (id: string | null) => void;
  setCurrentSkillIds: (ids: string[]) => void;
  setIsGenerating: (v: boolean) => void;
  setDraftPrompt: (prompt: string) => void;
  clearDraftPrompt: () => void;
  setContext: (conversationId: string, context: { type: string; label: string }[]) => void;
  addContext: (conversationId: string, chip: { type: string; label: string }) => void;
  removeContext: (conversationId: string, type: string) => void;
  setReasoningEffort: (level: ReasoningEffortLevel) => void;
  setConnectedMcpServices: (connections: AgentMcpConnection[]) => void;
  toggleConversationList: () => void;
  setConversationListOpen: (open: boolean) => void;
  setConversationListPlacement: (placement: ConversationListPlacement) => void;
  setConversationListWidth: (width: number) => void;
  setConversationModelSelectionId: (conversationId: string, selectionId: string) => void;
  setConversationSkillIds: (conversationId: string, skillIds: string[]) => void;
  replaceConversationMessages: (conversationId: string, messages: AiMessage[]) => void;
  /** 显式钉住工作区；传 null 恢复全局作用域 */
  pinConversationWorkspace: (conversationId: string, workspaceId: string | null) => void;
  attachTerminalSession: (conversationId: string, sessionId: string | null) => void;
  /**
   * 将终端内联 aiThread 投影为 Dock 会话（或写入指定会话）。
   * 返回目标 conversationId。
   */
  promoteInlineThread: (args: {
    title: string;
    messages: AiMessage[];
    terminalSessionId: string;
    sourceBlockId: string;
    targetConversationId?: string | null;
  }) => string;
  /**
   * 创建子会话（cursor sub-agent 范式）。
   * 继承父会话的 provider/model/skill/workspace/terminal context。
   * 不切换 activeConversationId；通过 viewingChildConversationId 进入查看。
   */
  createSubConversation: (args: {
    parentConversationId: string;
    parentMessageId: string;
    clusterId: string;
    title: string;
    indexInCluster: number;
    initialUserText: string;
  }) => string;
  /** 进入子会话视图；null 返回主会话 */
  setViewingChildConversation: (id: string | null) => void;
  /** 删除会话时级联删除其所有子会话 */
  deleteConversationCascade: (id: string) => void;
}

let idCounter = 0;
function genId(prefix: string): string {
  return `${prefix}_${Date.now()}_${++idCounter}`;
}

export const useAiStore = create<AiStore>()(
  persist(
    (set, get) => ({
      conversations: [],
      activeConversationId: null,
      drawerOpen: false,
      currentProvider: "openai",
      currentModel: "gpt-4o",
      currentModelSelectionId: null,
      currentSkillIds: [],
      isGenerating: false,
      draftPrompt: "",
      reasoningEffort: "default",
      connectedMcpServices: [],
      conversationListOpen: false,
      conversationListPlacement: "dropdown",
      conversationListWidth: 240,
      viewingChildConversationId: null,

      toggleDrawer: () =>
        set((state) => ({ drawerOpen: !state.drawerOpen })),

      openDrawer: () => set({ drawerOpen: true }),

      closeDrawer: () => set({ drawerOpen: false }),

      createConversation: (provider, model, options) => {
        const state = get();
        const agentId = options?.agentId ?? ASSISTANT_PAGE_AGENT_ID;
        const active = state.conversations.find((c) => c.id === state.activeConversationId);
        // 当前已是空白新会话时不再叠开一个（同 Agent）
        if (
          active &&
          active.messages.length === 0 &&
          (active.agentId ?? ASSISTANT_PAGE_AGENT_ID) === agentId
        ) {
          return active.id;
        }
        const id = genId("conv");
        const snapshot = useWorkspaceStore.getState().getSnapshot();
        const providers = useAiModelsStore.getState().providers;
        const modelSelectionId = resolveScenarioModelSelectionId(
          providers,
          state.currentModelSelectionId ??
            useSettingsStore.getState().aiScenarioAssistantModelSelectionId,
        );
        const parsed = modelSelectionId ? parseModelSelectionId(modelSelectionId) : null;
        const resolved = modelSelectionId
          ? resolveModelSelection(providers, modelSelectionId)
          : null;
        const conv: AiConversation = {
          id,
          title: "新的对话",
          messages: [],
          provider: provider || parsed?.providerId || state.currentProvider,
          model: model || parsed?.modelName || resolved?.name || state.currentModel,
          modelSelectionId,
          selectedSkillIds: [...state.currentSkillIds],
          agentId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          contextSnapshot: snapshot,
          // 工作区非必选：仅记录现场快照芯片，不自动 pin 工作区
          pinnedWorkspaceId: null,
          linkedTerminalSessionId: null,
          sourceBlockId: null,
          context: [
            ...(snapshot.activeResource
              ? [{ type: "resource", label: snapshot.activeResource.name }]
              : []),
          ],
        };
        set((s) => ({
          conversations: [conv, ...s.conversations],
          activeConversationId: id,
        }));
        // 新建会话：立即推 modules/assistant.json，勿等 debounce
        scheduleConversationListSnapshotSync({ immediate: true });
        return id;
      },

      ensureConversationId: (id, options) => {
        const wanted = String(id || "").trim();
        if (!wanted) {
          return get().createConversation(undefined, undefined, options);
        }
        const existing = get().conversations.find((c) => c.id === wanted);
        if (existing) {
          get().setActiveConversation(wanted);
          return wanted;
        }
        const state = get();
        const agentId = options?.agentId ?? ASSISTANT_PAGE_AGENT_ID;
        const snapshot = useWorkspaceStore.getState().getSnapshot();
        const providers = useAiModelsStore.getState().providers;
        const modelSelectionId = resolveScenarioModelSelectionId(
          providers,
          state.currentModelSelectionId ??
            useSettingsStore.getState().aiScenarioAssistantModelSelectionId,
        );
        const parsed = modelSelectionId ? parseModelSelectionId(modelSelectionId) : null;
        const resolved = modelSelectionId
          ? resolveModelSelection(providers, modelSelectionId)
          : null;
        const conv: AiConversation = {
          id: wanted,
          title: "新的对话",
          messages: [],
          provider: parsed?.providerId || state.currentProvider,
          model: parsed?.modelName || resolved?.name || state.currentModel,
          modelSelectionId,
          selectedSkillIds: [...state.currentSkillIds],
          agentId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          contextSnapshot: snapshot,
          pinnedWorkspaceId: null,
          linkedTerminalSessionId: null,
          sourceBlockId: null,
          context: [
            ...(snapshot.activeResource
              ? [{ type: "resource", label: snapshot.activeResource.name }]
              : []),
          ],
        };
        set((s) => ({
          conversations: [conv, ...s.conversations],
          activeConversationId: wanted,
          viewingChildConversationId: null,
        }));
        scheduleConversationListSnapshotSync({ immediate: true });
        return wanted;
      },

      setConversationAgentId: (conversationId, agentId) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? { ...c, agentId, updatedAt: Date.now() }
              : c,
          ),
        })),

      setActiveConversation: (id) => {
        const conversation = get().conversations.find((c) => c.id === id);
        set({
          activeConversationId: id,
          // 切会话时退出子会话只读视图，避免入站消息写到主会话却仍看着子会话
          viewingChildConversationId: null,
          ...(conversation?.modelSelectionId
            ? { currentModelSelectionId: conversation.modelSelectionId }
            : {}),
          ...(conversation?.selectedSkillIds
            ? { currentSkillIds: [...conversation.selectedSkillIds] }
            : { currentSkillIds: [] }),
        });
      },

      renameConversation: (id, title) => {
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === id ? { ...c, title, updatedAt: Date.now() } : c,
          ),
        }));
        scheduleConversationListSnapshotSync({ immediate: true });
      },

      deleteConversation: (id) => {
        set((state) => {
          const remaining = state.conversations.filter((c) => c.id !== id);
          const newActive =
            state.activeConversationId === id
              ? remaining.length > 0
                ? remaining[0].id
                : null
              : state.activeConversationId;
          return {
            conversations: remaining,
            activeConversationId: newActive,
          };
        });
        // 删除会话：立即推最新列表（助手快照 + 客户端间 tombstone）
        scheduleConversationListSnapshotSync({ immediate: true, deletedIds: [id] });
      },

      addMessage: (conversationId, msg) => {
        const msgId = genId("msg");
        const seedParts =
          msg.parts ??
          (msg.content
            ? ([{ type: "text", text: msg.content }] as AiMessagePart[])
            : []);
        const fullMsg = normalizeAiMessage({
          ...msg,
          parts: seedParts,
          id: msgId,
          timestamp: Date.now(),
        });
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            const messages = [...c.messages, fullMsg];
            // Auto-title from first user message
            const title =
              c.title === "新的对话" && msg.role === "user"
                ? msg.content.slice(0, 50) + (msg.content.length > 50 ? "..." : "")
                : c.title;
            return {
              ...c,
              messages,
              title,
              updatedAt: Date.now(),
            };
          }),
        }));
        return msgId;
      },

      updateMessage: (conversationId, messageId, update) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            return {
              ...c,
              messages: c.messages.map((m) => {
                if (m.id !== messageId) return m;
                const merged = { ...m, ...update };
                if (update.parts) {
                  return withUpdatedParts(m, update.parts, update);
                }
                return merged;
              }),
              updatedAt: Date.now(),
            };
          }),
        })),

      appendStreamContent: (conversationId, messageId, chunk) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            return {
              ...c,
              messages: c.messages.map((m) => {
                if (m.id !== messageId) return m;
                const parts = appendTextLikePart(
                  partsFromFlatFields(m),
                  "text",
                  chunk,
                );
                return withUpdatedParts(m, parts, {
                  isReasoningStreaming: chunk ? false : m.isReasoningStreaming,
                });
              }),
            };
          }),
        })),

      appendStreamReasoning: (conversationId, messageId, chunk) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            return {
              ...c,
              messages: c.messages.map((m) => {
                if (m.id !== messageId) return m;
                const parts = appendTextLikePart(
                  partsFromFlatFields(m),
                  "reasoning",
                  chunk,
                );
                return withUpdatedParts(m, parts, { isReasoningStreaming: true });
              }),
            };
          }),
        })),

      upsertStreamToolCall: (conversationId, messageId, toolCallId, name, args) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            return {
              ...c,
              messages: c.messages.map((m) => {
                if (m.id !== messageId) return m;
                const parts = upsertToolCallInParts(
                  partsFromFlatFields(m),
                  toolCallId,
                  name,
                  args,
                );
                return withUpdatedParts(m, parts);
              }),
              updatedAt: Date.now(),
            };
          }),
        })),

      updateStreamToolCall: (conversationId, messageId, toolCallId, status, result) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            return {
              ...c,
              messages: c.messages.map((m) => {
                if (m.id !== messageId) return m;
                const parts = updateToolCallInParts(
                  partsFromFlatFields(m),
                  toolCallId,
                  status,
                  result,
                );
                return withUpdatedParts(m, parts);
              }),
              updatedAt: Date.now(),
            };
          }),
        })),

      upsertStreamPlan: (conversationId, messageId, plan) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            return {
              ...c,
              messages: c.messages.map((m) => {
                if (m.id !== messageId) return m;
                const parts = upsertPlanInParts(partsFromFlatFields(m), plan);
                return withUpdatedParts(m, parts);
              }),
              updatedAt: Date.now(),
            };
          }),
        })),

      upsertStreamUserQuestion: (conversationId, messageId, form) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            return {
              ...c,
              messages: c.messages.map((m) => {
                if (m.id !== messageId) return m;
                const parts = upsertUserQuestionInParts(partsFromFlatFields(m), form);
                return withUpdatedParts(m, parts);
              }),
              updatedAt: Date.now(),
            };
          }),
        })),

      upsertStreamCluster: (conversationId, messageId, cluster) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            return {
              ...c,
              messages: c.messages.map((m) => {
                if (m.id !== messageId) return m;
                const parts = upsertClusterInParts(partsFromFlatFields(m), cluster);
                return withUpdatedParts(m, parts);
              }),
              updatedAt: Date.now(),
            };
          }),
        })),

      updateStreamClusterChild: (
        conversationId,
        messageId,
        clusterId,
        childConversationId,
        patch,
      ) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            return {
              ...c,
              messages: c.messages.map((m) => {
                if (m.id !== messageId) return m;
                const parts = updateClusterChildInParts(
                  partsFromFlatFields(m),
                  clusterId,
                  childConversationId,
                  patch,
                );
                return withUpdatedParts(m, parts);
              }),
              updatedAt: Date.now(),
            };
          }),
        })),

      setStreamClusterStatus: (conversationId, messageId, clusterId, status, aggregatedResult) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            return {
              ...c,
              messages: c.messages.map((m) => {
                if (m.id !== messageId) return m;
                const parts = updateClusterStatusInParts(
                  partsFromFlatFields(m),
                  clusterId,
                  status,
                  aggregatedResult,
                );
                return withUpdatedParts(m, parts);
              }),
              updatedAt: Date.now(),
            };
          }),
        })),

      setCurrentProvider: (provider, model) =>
        set({ currentProvider: provider, currentModel: model }),

      setCurrentModelSelectionId: (id) => set({ currentModelSelectionId: id }),

      setCurrentSkillIds: (ids) => set({ currentSkillIds: [...ids] }),

      setIsGenerating: (v) => {
        set({ isGenerating: v });
        // 一轮生成结束：刷新会话列表里的 messageCount / updatedAt
        if (!v) scheduleConversationListSnapshotSync();
      },

      setDraftPrompt: (prompt) => set({ draftPrompt: prompt }),

      clearDraftPrompt: () => set({ draftPrompt: "" }),

      setContext: (conversationId, context) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId ? { ...c, context } : c
          ),
        })),

      addContext: (conversationId, chip) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            const existing = c.context || [];
            if (existing.some((ch) => ch.type === chip.type && ch.label === chip.label)) return c;
            return { ...c, context: [...existing, chip] };
          }),
        })),

      removeContext: (conversationId, type) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            return {
              ...c,
              context: (c.context || []).filter((ch) => ch.type !== type),
            };
          }),
        })),

      setReasoningEffort: (level) => set({ reasoningEffort: level }),

      setConnectedMcpServices: (connections) => set({ connectedMcpServices: connections }),

      toggleConversationList: () =>
        set((state) => ({ conversationListOpen: !state.conversationListOpen })),

      setConversationListOpen: (open) => set({ conversationListOpen: open }),

      setConversationListPlacement: (placement) =>
        set(() => ({
          conversationListPlacement: placement,
          // 切到下拉时收起右侧面板；切到右侧时默认打开
          conversationListOpen: placement === "right" ? true : false,
        })),

      setConversationListWidth: (width) =>
        set({ conversationListWidth: Math.max(180, Math.min(420, width)) }),

      setConversationModelSelectionId: (conversationId, selectionId) => {
        const providers = useAiModelsStore.getState().providers;
        const parsed = parseModelSelectionId(selectionId);
        const resolved = resolveModelSelection(providers, selectionId);
        set((state) => ({
          currentModelSelectionId: selectionId,
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            return {
              ...c,
              modelSelectionId: selectionId,
              provider: parsed?.providerId ?? c.provider,
              model: parsed?.modelName ?? resolved?.name ?? c.model,
              updatedAt: Date.now(),
            };
          }),
        }));
      },

      setConversationSkillIds: (conversationId, skillIds) => {
        set((state) => ({
          currentSkillIds: [...skillIds],
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            return {
              ...c,
              selectedSkillIds: [...skillIds],
              updatedAt: Date.now(),
            };
          }),
        }));
      },

      replaceConversationMessages: (conversationId, messages) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  messages: messages.map((m) => normalizeAiMessage(m)),
                  updatedAt: Date.now(),
                }
              : c,
          ),
        })),

      pinConversationWorkspace: (conversationId, workspaceId) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            const ws = workspaceId
              ? useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId)
              : null;
            const context = (c.context || []).filter((ch) => ch.type !== "workspace");
            if (ws) {
              context.unshift({ type: "workspace", label: ws.name });
            }
            return {
              ...c,
              pinnedWorkspaceId: workspaceId,
              context,
              updatedAt: Date.now(),
            };
          }),
        })),

      attachTerminalSession: (conversationId, sessionId) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? { ...c, linkedTerminalSessionId: sessionId, updatedAt: Date.now() }
              : c,
          ),
        })),

      promoteInlineThread: ({
        title,
        messages,
        terminalSessionId,
        sourceBlockId,
        targetConversationId,
      }) => {
        const state = get();
        const normalized = messages.map((m) => normalizeAiMessage(m));
        if (targetConversationId) {
          set({
            conversations: state.conversations.map((c) =>
              c.id === targetConversationId
                ? {
                    ...c,
                    messages: [...c.messages, ...normalized],
                    linkedTerminalSessionId: terminalSessionId,
                    sourceBlockId,
                    agentId: "terminal",
                    title: c.title === "新的对话" ? title : c.title,
                    updatedAt: Date.now(),
                  }
                : c,
            ),
            activeConversationId: targetConversationId,
          });
          return targetConversationId;
        }
        const id = get().createConversation(undefined, undefined, {
          agentId: "terminal",
        });
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === id
              ? {
                  ...c,
                  title,
                  messages: normalized,
                  linkedTerminalSessionId: terminalSessionId,
                  sourceBlockId,
                  agentId: "terminal",
                  updatedAt: Date.now(),
                }
              : c,
          ),
        }));
        return id;
      },

      createSubConversation: ({
        parentConversationId,
        parentMessageId,
        clusterId,
        title,
        indexInCluster,
        initialUserText,
      }) => {
        const state = get();
        const parent = state.conversations.find((c) => c.id === parentConversationId);
        if (!parent) {
          throw new Error(`createSubConversation: 父会话不存在 ${parentConversationId}`);
        }
        const id = genId("subconv");
        const rootId = parent.rootConversationId ?? parent.id;
        // 继承父会话的 provider/model/skill/workspace/terminal/agent
        const conv: AiConversation = {
          id,
          title,
          messages: initialUserText
            ? [
                normalizeAiMessage({
                  id: genId("msg"),
                  role: "user" as const,
                  content: initialUserText,
                  parts: [{ type: "text" as const, text: initialUserText }],
                  timestamp: Date.now(),
                }),
              ]
            : [],
          provider: parent.provider,
          model: parent.model,
          modelSelectionId: parent.modelSelectionId,
          selectedSkillIds: parent.selectedSkillIds
            ? [...parent.selectedSkillIds]
            : undefined,
          agentId: parent.agentId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          context: parent.context ? [...parent.context] : undefined,
          contextSnapshot: parent.contextSnapshot,
          pinnedWorkspaceId: parent.pinnedWorkspaceId ?? null,
          linkedTerminalSessionId: parent.linkedTerminalSessionId ?? null,
          sourceBlockId: null,
          parentConversationId,
          rootConversationId: rootId,
          spawnedFromMessageId: parentMessageId,
          spawnedFromClusterId: clusterId,
          indexInCluster,
        };
        set((s) => ({
          conversations: [...s.conversations, conv],
        }));
        scheduleConversationListSnapshotSync({ immediate: true });
        return id;
      },

      setViewingChildConversation: (id) => {
        if (id === null) {
          set({ viewingChildConversationId: null });
          return;
        }
        // 校验：必须存在且为子会话
        const conv = get().conversations.find((c) => c.id === id);
        if (!conv || !conv.parentConversationId) {
          console.warn(`setViewingChildConversation: ${id} 不是子会话`);
          return;
        }
        set({ viewingChildConversationId: id });
      },

      deleteConversationCascade: (id) => {
        const deletedIds: string[] = [];
        set((state) => {
          // 收集所有直接与间接子会话
          const toDelete = new Set<string>([id]);
          let changed = true;
          while (changed) {
            changed = false;
            for (const c of state.conversations) {
              if (
                c.parentConversationId &&
                toDelete.has(c.parentConversationId) &&
                !toDelete.has(c.id)
              ) {
                toDelete.add(c.id);
                changed = true;
              }
            }
          }
          deletedIds.push(...toDelete);
          const remaining = state.conversations.filter((c) => !toDelete.has(c.id));
          const newActive =
            state.activeConversationId && toDelete.has(state.activeConversationId)
              ? remaining.find((c) => !c.parentConversationId)?.id ?? null
              : state.activeConversationId;
          const newViewing =
            state.viewingChildConversationId &&
            toDelete.has(state.viewingChildConversationId)
              ? null
              : state.viewingChildConversationId;
          return {
            conversations: remaining,
            activeConversationId: newActive,
            viewingChildConversationId: newViewing,
          };
        });
        scheduleConversationListSnapshotSync({ immediate: true, deletedIds });
      },
    }),
    {
      name: "omnipanel-ai-store",
      storage: createJSONStorage(createIndexedDBStorage),
      version: 7,
      migrate: (persisted, version) => {
        const state = persisted as {
          conversations?: AiConversation[];
          reasoningEffort?: string;
          [key: string]: unknown;
        };
        if (!state || typeof state !== "object") return persisted as unknown as AiStore;
        let next = { ...state } as unknown as AiStore;
        if (version < 2 && Array.isArray(state.conversations)) {
          next = {
            ...next,
            conversations: state.conversations.map((c) => ({
              ...c,
              messages: (c.messages ?? []).map((m) => normalizeAiMessage(m)),
            })),
          };
        }
        // v3：默认不再强制带 enable_thinking，避免部分上游 400
        if (version < 3) {
          next = { ...next, reasoningEffort: "default" };
        }
        // v4：会话绑定逻辑 Agent；历史会话默认助手页 Agent（当前为 run）
        if (version < 4 && Array.isArray(next.conversations)) {
          next = {
            ...next,
            conversations: next.conversations.map((c) => {
              if (isAgentId(c.agentId)) return c;
              // 从终端提升的会话归 terminal Agent，其余归助手页默认
              const inferred: AgentId = c.sourceBlockId || c.linkedTerminalSessionId
                ? "terminal"
                : ASSISTANT_PAGE_AGENT_ID;
              return { ...c, agentId: inferred };
            }),
          };
        }
        // v5：SSH Agent 已并入终端 Agent
        if (version < 5 && Array.isArray(next.conversations)) {
          next = {
            ...next,
            conversations: next.conversations.map((c) =>
              (c.agentId as string | undefined) === "ssh"
                ? { ...c, agentId: "terminal" as AgentId }
                : c,
            ),
          };
        }
        // v6：助手 Agent 由 chat 重命名为 plan
        if (version < 6 && Array.isArray(next.conversations)) {
          next = {
            ...next,
            conversations: next.conversations.map((c) =>
              (c.agentId as string | undefined) === "chat"
                ? { ...c, agentId: "plan" as AgentId }
                : c,
            ),
          };
        }
        // v7：子会话父子关系字段初始化（旧会话均为根会话）
        if (version < 7 && Array.isArray(next.conversations)) {
          next = {
            ...next,
            conversations: next.conversations.map((c) =>
              c.parentConversationId == null
                ? {
                    ...c,
                    parentConversationId: null,
                    rootConversationId: c.id,
                  }
                : c,
            ),
            viewingChildConversationId: null,
          };
        }
        return next;
      },
      partialize: (state) => ({
        conversations: state.conversations,
        activeConversationId: state.activeConversationId,
        currentProvider: state.currentProvider,
        currentModel: state.currentModel,
        currentModelSelectionId: state.currentModelSelectionId,
        currentSkillIds: state.currentSkillIds,
        reasoningEffort: state.reasoningEffort,
        conversationListOpen: state.conversationListOpen,
        conversationListPlacement: state.conversationListPlacement,
        conversationListWidth: state.conversationListWidth,
        /** AI 侧栏/Dock 开关：重启后保持 */
        drawerOpen: state.drawerOpen,
        /** 子会话查看模式：重启后保持（在主会话内才能进入，故 activeConversationId 须为父会话） */
        viewingChildConversationId: state.viewingChildConversationId,
      }),
    }
  )
);
