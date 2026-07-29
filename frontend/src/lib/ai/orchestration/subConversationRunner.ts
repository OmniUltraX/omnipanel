/**
 * 子会话并发执行器（cursor sub-agent 范式）。
 *
 * 核心职责：
 * - 为每个 spawn spec 创建独立子会话（继承父会话的模型 / Skill / 工作区上下文）
 * - 并发执行子会话的 ai_chat_stream（max 5 并发，worker pool 模式）
 * - 流式事件写入子会话的 assistant message
 * - 子会话工具调用走统一的 dispatchPendingTool 通道
 * - 聚合所有子会话结果，返回给父会话的 toolCall
 *
 * 取消传播：
 * - 集群 abort → 所有子会话级联 abort
 * - 单个子会话 abort → 仅该子会话取消，集群继续
 * - 父会话取消 → cancelConversationClusters 级联取消所有集群
 */
import { useAiStore } from "../../../stores/aiStore";
import {
  useAiOrchestrationStore,
  type SubConversationClusterRuntime,
} from "../../../stores/aiOrchestrationStore";
import { useConnectionStore } from "../../../stores/connectionStore";
import { useWorkspaceMembershipStore } from "../../../stores/workspaceMembershipStore";
import {
  resolveBackendFromSelection,
  type HttpProviderSnapshot,
} from "../inferenceBackend";
import { useAiModelsStore } from "../../../stores/aiModelsStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { resolveConversationModelSelectionId } from "../../aiScenarioModels";
import { resolveAgentRuntime, ASSISTANT_PAGE_AGENT_ID } from "../agents";
import { resolveKnowledgeEmbeddingProvider } from "../../knowledgeEmbeddingModel";
import { runInternalAiChat, type InternalStreamEvent } from "../orchestrator";
import { dispatchPendingTool } from "../internalToolBridge";
import { errorToString } from "../../errorToString";
import { reportToolResultWithRetry } from "../reportToolResult";
import {
  getChildAbortController,
  checkClusterCompletion,
  cleanupChildAbortController,
} from "./clusterCancellation";
import { buildChildAiContextBundle } from "./childRequestContext";
import type {
  SubConversationChildState,
  SubConversationClusterStatus,
  SubConversationSpawnSpec,
} from "../aiMessageParts";

/** 最大并发子会话数 */
const MAX_CONCURRENCY = 5;

/** 单个子会话超时（ms）：10 分钟，覆盖大部分运维任务 */
const CHILD_TIMEOUT_MS = 10 * 60 * 1000;

/** 子会话摘要最大长度 */
const SUMMARY_MAX_LENGTH = 500;

/** SSH 主机上限（与 omni_spawn_sub_conversations 的 max_items 对齐） */
const SSH_FLEET_HOST_LIMIT = 20;

/**
 * 解析 SSH 主机列表（从 connectionStore + workspaceMembershipStore）。
 *
 * - workspaceId 为 null 时返回全部 SSH 连接
 * - workspaceId 非空但工作区无成员时回落到全部（兼容空工作区）
 * - 否则返回工作区 membership 内的 SSH 连接
 *
 * 从 mcpTools.ts 迁移而来：原 sshFleetHealthCheck 内联使用，
 * 现改为 sub-conv 模型后由 dispatchSshFleetHealthAsSubConv 复用。
 */
function resolveSshHosts(workspaceId: string | null): { id: string; name: string }[] {
  const all = useConnectionStore.getState().connections.filter((c) => c.kind === "ssh");
  if (!workspaceId) {
    return all.map((c) => ({ id: c.id, name: c.name }));
  }
  const members = new Set(
    useWorkspaceMembershipStore.getState().getWorkspaceResourceIds(workspaceId),
  );
  if (members.size === 0) {
    return all.map((c) => ({ id: c.id, name: c.name }));
  }
  return all.filter((c) => members.has(c.id)).map((c) => ({ id: c.id, name: c.name }));
}

export interface SpawnClusterOptions {
  /** 父会话 id */
  parentConversationId: string;
  /** 父消息 id（cluster part 所在 message） */
  parentMessageId: string;
  /** 集群 id */
  clusterId: string;
  /** 触发集群的 toolCallId */
  toolCallId: string;
  /** 集群标题 */
  title: string;
  /** 子会话规格列表 */
  specs: SubConversationSpawnSpec[];
}

export interface ClusterResult {
  /** 聚合后的结果字符串（回传给父会话 toolCall） */
  aggregatedResult: string;
  /** 集群最终状态 */
  status: SubConversationClusterStatus;
  /** 统计 */
  stats: { total: number; completed: number; failed: number; cancelled: number };
}

/**
 * 创建集群运行时状态并写入 store + message parts。
 * 调用方负责在调用 runCluster 之前完成此步骤。
 */
export function initClusterRuntime(options: SpawnClusterOptions): void {
  const { parentConversationId, parentMessageId, clusterId, toolCallId, title, specs } = options;
  const now = Date.now();

  // 1. 创建子会话（但暂不启动）
  const children: SubConversationChildState[] = specs.map((spec, index) => {
    const childConversationId = useAiStore.getState().createSubConversation({
      parentConversationId,
      parentMessageId,
      clusterId,
      title: spec.title,
      indexInCluster: index,
      initialUserText: spec.task,
    });
    return {
      conversationId: childConversationId,
      index: index,
      title: spec.title,
      status: "pending" as const,
      spawnSpec: spec,
      resourceId: spec.resourceId,
    };
  });

  // 2. 写入 orchestration store
  const runtime: SubConversationClusterRuntime = {
    clusterId,
    title,
    toolCallId,
    parentConversationId,
    parentMessageId,
    status: "pending",
    children,
    createdAt: now,
  };
  useAiOrchestrationStore.getState().createCluster(runtime);

  // 3. 同步到父消息的 cluster part
  useAiStore.getState().upsertStreamCluster(parentConversationId, parentMessageId, {
    clusterId,
    title,
    toolCallId,
    status: "pending",
    children,
    createdAt: now,
  });
}

/**
 * 并发执行集群中所有子会话。
 *
 * 返回聚合结果。调用方负责将结果回传给父会话的 toolCall。
 */
export async function runCluster(options: SpawnClusterOptions): Promise<ClusterResult> {
  const { clusterId, parentConversationId, parentMessageId, title } = options;
  const store = useAiOrchestrationStore.getState();
  const cluster = store.clusters[clusterId];
  if (!cluster) {
    return {
      aggregatedResult: JSON.stringify({ ok: false, error: "集群不存在" }),
      status: "failed",
      stats: { total: 0, completed: 0, failed: 0, cancelled: 0 },
    };
  }

  // 更新集群状态 → running
  useAiOrchestrationStore.getState().setClusterStatus(clusterId, "running");
  useAiStore.getState().setStreamClusterStatus(
    parentConversationId,
    parentMessageId,
    clusterId,
    "running",
  );

  // 并发执行子会话
  const children = cluster.children;
  const results: ChildExecutionResult[] = new Array(children.length);

  await mapPool(
    children,
    MAX_CONCURRENCY,
    async (child, index) => {
      results[index] = await runSingleChild(clusterId, child);
    },
    () => {
      // 检查集群是否已被取消
      const c = useAiOrchestrationStore.getState().clusters[clusterId];
      return c?.status === "cancelled";
    },
  );

  // 聚合结果
  return aggregateResults(clusterId, title, results, children);
}

interface ChildExecutionResult {
  status: SubConversationChildState["status"];
  summary?: string;
  error?: string;
  conversationId: string;
  title: string;
}

/**
 * 执行单个子会话。
 *
 * 流程：
 * 1. 获取子会话的 AbortController（链接到集群 controller）
 * 2. 解析子会话的 backend（继承父会话模型）
 * 3. 创建 assistant message（streaming）
 * 4. 调用 runInternalAiChat
 * 5. 处理流事件：content/reasoning/tool_call/permission/usage/done
 * 6. 子会话工具调用走 dispatchPendingTool（非 inline 模式）
 * 7. 完成后提取最后一条 assistant 消息作为摘要
 */
async function runSingleChild(
  clusterId: string,
  child: SubConversationChildState,
): Promise<ChildExecutionResult> {
  const { conversationId, title, spawnSpec } = child;
  const aiStore = useAiStore.getState();
  const orchStore = useAiOrchestrationStore.getState();

  // 更新子会话状态 → running
  orchStore.updateClusterChild(clusterId, conversationId, {
    status: "running",
    startedAt: Date.now(),
  });
  // 同步到 message parts
  const cluster = orchStore.clusters[clusterId];
  if (cluster?.parentConversationId && cluster?.parentMessageId) {
    useAiStore.getState().updateStreamClusterChild(
      cluster.parentConversationId,
      cluster.parentMessageId,
      clusterId,
      conversationId,
      { status: "running", startedAt: Date.now() },
    );
  }

  // 获取子会话的 abort controller
  const abortController = getChildAbortController(clusterId, conversationId);

  try {
    // 解析子会话的 backend（继承父会话模型）
    const childConv = useAiStore.getState().conversations.find((c) => c.id === conversationId);
    if (!childConv) {
      throw new Error(`子会话不存在: ${conversationId}`);
    }

    const providers = useAiModelsStore.getState().providers;
    const assistantDefaultId =
      useSettingsStore.getState().aiScenarioAssistantModelSelectionId;
    const selectionId = resolveConversationModelSelectionId(
      providers,
      childConv,
      assistantDefaultId,
      null,
    );
    const backend = resolveBackendFromSelection(providers, selectionId);
    if (!backend) {
      throw new Error("子会话未配置 AI 模型；请在设置中配置并选择模型");
    }

    // 解析 Agent runtime（子会话继承父会话的 agentId）
    const agentRuntime = resolveAgentRuntime({
      assistantPage: true,
      conversationAgentId: childConv.agentId ?? ASSISTANT_PAGE_AGENT_ID,
    });

    // 创建 assistant message（streaming）
    const assistantMsgId = aiStore.addMessage(conversationId, {
      role: "assistant",
      content: "",
      isStreaming: true,
      isReasoningStreaming: true,
    });

    // 工具元数据缓存（与 AiRuntimeProvider 一致的模式）
    const toolMeta = new Map<string, { name: string; args: string }>();
    const pendingTools = new Set<string>();

    // 流式事件处理
    const onEvent = (event: InternalStreamEvent) => {
      if (abortController.signal.aborted) return;

      switch (event.type) {
        case "content_delta":
          useAiStore.getState().appendStreamContent(conversationId, assistantMsgId, event.text);
          break;
        case "reasoning_delta":
          useAiStore.getState().appendStreamReasoning(conversationId, assistantMsgId, event.text);
          break;
        case "tool_call":
          if (event.name.trim()) {
            toolMeta.set(event.id, { name: event.name, args: event.arguments });
            useAiStore.getState().upsertStreamToolCall(
              conversationId,
              assistantMsgId,
              event.id,
              event.name,
              event.arguments,
            );
          }
          break;
        case "tool_call_update":
          // 工具进入 pending：分派执行
          if (event.status === "pending") {
            const meta = toolMeta.get(event.id);
            if (meta && !pendingTools.has(event.id)) {
              pendingTools.add(event.id);
              void dispatchPendingTool({
                conversationId,
                toolCallId: event.id,
                toolName: meta.name,
                argsJson: meta.args,
                inline: null,
                terminalSessionId: childConv.linkedTerminalSessionId ?? null,
              }).finally(() => pendingTools.delete(event.id));
            }
          }
          // 更新 tool-call part 状态
          useAiStore.getState().updateStreamToolCall(
            conversationId,
            assistantMsgId,
            event.id,
            event.status === "completed" ? "completed" : event.status === "failed" ? "failed" : "running",
            event.result ?? undefined,
          );
          break;
        case "permission_request":
          // 子会话的权限请求走统一的 ACP 审批队列
          // 复用 AiRuntimeProvider 的 enqueueAcpPermission 逻辑
          // 这里直接调用 respondAcpPermission 的封装（通过 CustomEvent 委托给主 runtime）
          window.dispatchEvent(
            new CustomEvent("omnipanel:acp-permission-request", {
              detail: { event, conversationId },
            }),
          );
          break;
        case "usage":
          if (event.type === "usage") {
            useAiStore.getState().updateMessage(conversationId, assistantMsgId, {
              usage: { inputTokens: event.input_tokens, outputTokens: event.output_tokens },
            });
          }
          break;
        case "error":
          useAiStore.getState().appendStreamContent(
            conversationId,
            assistantMsgId,
            `\n\nError: ${event.message}`,
          );
          break;
        case "done":
          // 标记完成
          useAiStore.getState().updateMessage(conversationId, assistantMsgId, {
            isStreaming: false,
            isReasoningStreaming: false,
          });
          break;
        default:
          break;
      }
    };

    // 知识库 RAG 配置
    const embeddingProvider =
      agentRuntime.allowRag && backend.kind === "http"
        ? resolveKnowledgeEmbeddingProvider(providers, {
            knowledgeEmbeddingModelMode: useSettingsStore.getState().knowledgeEmbeddingModelMode,
            knowledgeEmbeddingModelSelectionId:
              useSettingsStore.getState().knowledgeEmbeddingModelSelectionId,
            knowledgeEmbeddingOllamaModel:
              useSettingsStore.getState().knowledgeEmbeddingOllamaModel,
          })
        : null;

    // 构建 historyJson（子会话已有 initial user message）
    const childMessages = childConv.messages.filter(
      (m) => m.role === "user" || m.role === "assistant",
    );
    const historyJson =
      childMessages.length > 0
        ? JSON.stringify(
            childMessages.map((m) => ({ role: m.role, content: m.content })),
          )
        : null;

    // 超时保护
    const timeoutController = new AbortController();
    const timeoutId = window.setTimeout(() => timeoutController.abort(), CHILD_TIMEOUT_MS);

    // 链接 abort：集群/超时 → 执行 abort
    const onClusterAbort = () => timeoutController.abort();
    abortController.signal.addEventListener("abort", onClusterAbort, { once: true });

    try {
      const parentConv = cluster?.parentConversationId
        ? useAiStore.getState().conversations.find((c) => c.id === cluster.parentConversationId)
        : null;
      const childContext = buildChildAiContextBundle({
        parent: parentConv,
        child: childConv,
        spawnResourceId: spawnSpec.resourceId ?? child.resourceId ?? null,
      });

      await runInternalAiChat({
        request: {
          conversationId,
          userText: spawnSpec.task,
          backendId: backend.backendId,
          httpProvider: backend.kind === "http" ? (backend as { httpProvider: HttpProviderSnapshot }).httpProvider : null,
          context: childContext,
          historyJson,
          toolsMode: (() => {
            const mode = agentRuntime.toolsMode;
            if (mode === "none") return "none" as const;
            return {
              directInject: {
                moduleFilter: mode.directInject.moduleFilter ?? null,
                toolAllowlist: mode.directInject.toolAllowlist ?? null,
              },
            };
          })(),
          embeddingProvider,
          skillIds: childConv.selectedSkillIds ?? null,
          reasoningEffort: useAiStore.getState().reasoningEffort,
          agentId: agentRuntime.agentId,
          agentSystemRole: agentRuntime.systemRole,
        },
        signal: timeoutController.signal,
        onEvent,
      });
    } finally {
      window.clearTimeout(timeoutId);
      abortController.signal.removeEventListener("abort", onClusterAbort);
    }

    // 提取摘要：最后一条 assistant 消息的 content
    const updatedConv = useAiStore.getState().conversations.find((c) => c.id === conversationId);
    const lastAssistant = updatedConv?.messages
      .filter((m) => m.role === "assistant")
      .pop();
    const summary = lastAssistant?.content?.slice(0, SUMMARY_MAX_LENGTH) ?? "(无输出)";

    // 更新子会话状态 → completed
    useAiOrchestrationStore.getState().updateClusterChild(clusterId, conversationId, {
      status: "completed",
      summary,
      finishedAt: Date.now(),
    });
    if (cluster?.parentConversationId && cluster?.parentMessageId) {
      useAiStore.getState().updateStreamClusterChild(
        cluster.parentConversationId,
        cluster.parentMessageId,
        clusterId,
        conversationId,
        { status: "completed", summary, finishedAt: Date.now() },
      );
    }

    return { status: "completed", summary, conversationId, title };
  } catch (err) {
    const aborted = abortController.signal.aborted;
    const errorMessage = aborted ? "已取消" : errorToString(err);

    // 标记 assistant message 完成
    const updatedConv = useAiStore.getState().conversations.find((c) => c.id === conversationId);
    if (updatedConv) {
      const lastAssistant = updatedConv.messages
        .filter((m) => m.role === "assistant")
        .pop();
      if (lastAssistant?.isStreaming) {
        useAiStore.getState().updateMessage(conversationId, lastAssistant.id, {
          isStreaming: false,
          isReasoningStreaming: false,
        });
      }
    }

    const status: SubConversationChildState["status"] = aborted ? "cancelled" : "failed";

    // 更新子会话状态
    useAiOrchestrationStore.getState().updateClusterChild(clusterId, conversationId, {
      status,
      error: aborted ? undefined : errorMessage,
      finishedAt: Date.now(),
    });
    if (cluster?.parentConversationId && cluster?.parentMessageId) {
      useAiStore.getState().updateStreamClusterChild(
        cluster.parentConversationId,
        cluster.parentMessageId,
        clusterId,
        conversationId,
        { status, error: aborted ? undefined : errorMessage, finishedAt: Date.now() },
      );
    }

    return {
      status,
      error: aborted ? undefined : errorMessage,
      conversationId,
      title,
    };
  } finally {
    cleanupChildAbortController(conversationId);
  }
}

/**
 * 聚合子会话结果。
 */
function aggregateResults(
  clusterId: string,
  title: string,
  results: ChildExecutionResult[],
  _children: SubConversationChildState[],
): ClusterResult {
  // 检查集群最终状态
  checkClusterCompletion(clusterId);

  const cluster = useAiOrchestrationStore.getState().clusters[clusterId];
  const finalStatus = cluster?.status ?? "completed";

  const stats = {
    total: results.length,
    completed: results.filter((r) => r.status === "completed").length,
    failed: results.filter((r) => r.status === "failed").length,
    cancelled: results.filter((r) => r.status === "cancelled").length,
  };

  // 构建聚合结果（回传给父会话 toolCall）
  const reports = results.map((r, i) => ({
    index: i,
    title: r.title,
    status: r.status,
    summary: r.summary ?? r.error ?? "(无输出)",
    conversationId: r.conversationId,
  }));

  const aggregatedResult = JSON.stringify(
    {
      ok: finalStatus === "completed" || finalStatus === "failed",
      clusterId,
      title,
      status: finalStatus,
      stats,
      reports,
      hint:
        finalStatus === "completed"
          ? "请根据各子会话 summary 给出综合分析与下一步建议。"
          : finalStatus === "cancelled"
            ? "集群已取消；部分子会话可能未完成。请根据已完成的结果给出部分结论。"
            : "部分子会话失败；请根据成功与失败的结果给出诊断与修复建议。",
    },
    null,
    2,
  );

  return { aggregatedResult, status: finalStatus, stats };
}

/**
 * 并发 worker pool（与 mcpTools.ts 的 mapPool 一致模式）。
 *
 * - limit：最大并发数
 * - shouldAbort：每次取下一个任务前检查，true 则停止
 */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  shouldAbort: () => boolean,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      if (shouldAbort()) return;
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  const n = Math.min(limit, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

// ========== dispatch 入口：omni_spawn_sub_conversations 工具拦截 ==========

/** clusterId 自增序号（模块级，避免短期内重复） */
let clusterSeq = 0;

/**
 * 共享的子会话集群执行逻辑：找到父消息 → init cluster → run cluster → 回传结果。
 *
 * 被 dispatchSpawnSubConversations 和 dispatchSshFleetHealthAsSubConv 复用，
 * 避免两处重复实现「找父消息 + init + run + report + error handling」流程。
 *
 * 此函数会阻塞直到集群完成（最长 10 分钟 / 子会话）。
 * 调用方（dispatchPendingTool）以 fire-and-forget 模式调用，不阻塞主流程。
 *
 * 取消传播：
 * - 主会话取消 → AiRuntimeProvider.handleCancel 调用 cancelConversationClusters → 级联取消所有集群
 * - 集群取消 → cancelCluster abort 集群 controller → 所有子会话级联 abort
 * - 单个子会话取消 → cancelClusterChild abort 该子会话 controller，集群继续
 */
async function runSubConversationClusterFromSpecs(options: {
  conversationId: string;
  toolCallId: string;
  specs: SubConversationSpawnSpec[];
  title?: string;
}): Promise<void> {
  const { conversationId, toolCallId, specs, title } = options;

  // 1. 找到父消息（包含 toolCallId 的 streaming assistant message）
  const conv = useAiStore.getState().conversations.find((c) => c.id === conversationId);
  if (!conv) {
    await reportToolResultWithRetry(
      conversationId,
      toolCallId,
      `父会话不存在: ${conversationId}`,
      false,
    );
    return;
  }

  const parentMessage = conv.messages.find(
    (m) => Array.isArray(m.parts) && m.parts.some((p) => p.type === "tool-call" && p.id === toolCallId),
  );
  if (!parentMessage) {
    await reportToolResultWithRetry(
      conversationId,
      toolCallId,
      `找不到包含 toolCallId ${toolCallId} 的父消息`,
      false,
    );
    return;
  }

  // 2. 生成 clusterId 与标题
  const clusterId = `cluster_${Date.now()}_${(++clusterSeq).toString(36)}`;
  const resolvedTitle = title ?? `子会话集群 · ${specs.length} 个任务`;

  // 3. 构造 spawn options
  const spawnOptions: SpawnClusterOptions = {
    parentConversationId: conversationId,
    parentMessageId: parentMessage.id,
    clusterId,
    toolCallId,
    title: resolvedTitle,
    specs,
  };

  // 4. initClusterRuntime（写入 store + message parts）
  initClusterRuntime(spawnOptions);

  // 5. runCluster（阻塞直到所有子会话完成）
  try {
    const result = await runCluster(spawnOptions);

    // 6. 回传聚合结果（cancelled 也回传部分结果，供模型给出部分结论）
    await reportToolResultWithRetry(
      conversationId,
      toolCallId,
      result.aggregatedResult,
      result.status !== "cancelled",
    );
  } catch (err) {
    const errorMessage = errorToString(err);
    // 标记集群失败并同步 message parts
    useAiOrchestrationStore.getState().setClusterStatus(clusterId, "failed", errorMessage);
    const cluster = useAiOrchestrationStore.getState().clusters[clusterId];
    if (cluster?.parentConversationId && cluster?.parentMessageId) {
      useAiStore.getState().setStreamClusterStatus(
        cluster.parentConversationId,
        cluster.parentMessageId,
        clusterId,
        "failed",
        errorMessage,
      );
    }
    await reportToolResultWithRetry(
      conversationId,
      toolCallId,
      `子会话集群执行失败: ${errorMessage}`,
      false,
    );
  }
}

/**
 * dispatchPendingTool 入口：拦截 omni_spawn_sub_conversations 工具调用。
 *
 * 流程：
 * 1. 解析 args（sub_conversations + title）
 * 2. 委托 runSubConversationClusterFromSpecs 执行集群
 */
export async function dispatchSpawnSubConversations(options: {
  conversationId: string;
  toolCallId: string;
  argsJson: string;
}): Promise<void> {
  const { conversationId, toolCallId, argsJson } = options;

  // 1. 解析 args
  let specs: SubConversationSpawnSpec[];
  let title: string | undefined;
  try {
    const parsed = JSON.parse(argsJson || "{}") as {
      sub_conversations?: unknown;
      title?: unknown;
    };
    if (!Array.isArray(parsed.sub_conversations) || parsed.sub_conversations.length === 0) {
      throw new Error("sub_conversations 必须是非空数组");
    }
    if (parsed.sub_conversations.length > 20) {
      throw new Error("sub_conversations 最多 20 个");
    }
    specs = parsed.sub_conversations.map((raw, i) => {
      if (!raw || typeof raw !== "object") {
        throw new Error(`sub_conversations[${i}] 必须是对象`);
      }
      const obj = raw as Record<string, unknown>;
      const titleVal = obj.title;
      const taskVal = obj.task;
      if (typeof titleVal !== "string" || !titleVal.trim()) {
        throw new Error(`sub_conversations[${i}].title 必须是非空字符串`);
      }
      if (typeof taskVal !== "string" || !taskVal.trim()) {
        throw new Error(`sub_conversations[${i}].task 必须是非空字符串`);
      }
      const resourceIdVal = obj.resource_id;
      const spec: SubConversationSpawnSpec = {
        title: titleVal.trim(),
        task: taskVal.trim(),
        ...(typeof resourceIdVal === "string" && resourceIdVal.trim()
          ? { resourceId: resourceIdVal.trim() }
          : {}),
      };
      return spec;
    });
    title = typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : undefined;
  } catch (err) {
    await reportToolResultWithRetry(
      conversationId,
      toolCallId,
      `参数解析失败: ${errorToString(err)}`,
      false,
    );
    return;
  }

  // 2. 委托共享逻辑
  return runSubConversationClusterFromSpecs({ conversationId, toolCallId, specs, title });
}

/**
 * dispatchPendingTool 入口：拦截 omni_orchestration_ssh_fleet_health 工具调用。
 *
 * 这是「SSH 体检」工具的 sub-conv 模型迁移版本（原 mcpTools.ts 中的
 * sshFleetHealthCheck 已移除）。AI 调用此工具时只需传 workspace_id，
 * 内部自动解析 SSH 主机列表并为每台主机派发一个独立的子会话（cursor
 * sub-agent 范式），每个子会话调用 omni_ssh_get_stats 并给出健康评估。
 *
 * 与旧实现的区别：
 * - 旧：直接调用 omni_ssh_get_stats 扇出采集，返回原始 stats 给主会话 AI 分析
 * - 新：每台主机一个子会话，子会话 AI 自主分析并返回评估结果，主会话 AI 做最终汇总
 * - 优势：每台主机得到独立的深度分析（而非原始数据），主会话 AI 负担更轻
 * - 可视化：集群进度卡片在对话流与任务中心显示，每台主机可展开查看子会话
 *
 * 流程：
 * 1. 解析 workspace_id（可选，回落到会话钉住的工作区）
 * 2. 解析 SSH 主机列表（workspace membership 或全局）
 * 3. 主机数 > 20 时返回错误（sub-conv 上限，建议缩小范围）
 * 4. 为每台主机构造子会话规格（task: 体检 + 分析 + 评估）
 * 5. 委托 runSubConversationClusterFromSpecs 执行集群
 *
 * 兼容性：AiTaskParent 类型与 kind: "sshFleetHealth" 字符串仍保留（旧持久化
 * 数据可读），但新创建的体检任务使用 SubConversationClusterRuntime 而非 AiTaskParent。
 */
export async function dispatchSshFleetHealthAsSubConv(options: {
  conversationId: string;
  toolCallId: string;
  argsJson: string;
}): Promise<void> {
  const { conversationId, toolCallId, argsJson } = options;

  // 1. 解析 workspace_id
  let workspaceId: string | null = null;
  try {
    const parsed = JSON.parse(argsJson || "{}") as { workspace_id?: unknown };
    const wsVal = parsed.workspace_id;
    if (wsVal !== undefined && wsVal !== null) {
      if (typeof wsVal !== "string") {
        throw new Error("workspace_id 必须是字符串");
      }
      if (wsVal.trim()) {
        workspaceId = wsVal.trim();
      }
    }
  } catch (err) {
    await reportToolResultWithRetry(
      conversationId,
      toolCallId,
      `参数解析失败: ${errorToString(err)}`,
      false,
    );
    return;
  }

  // 2. 回落到会话钉住的工作区
  if (!workspaceId) {
    const pinned = useAiStore
      .getState()
      .conversations.find((c) => c.id === conversationId)?.pinnedWorkspaceId;
    if (pinned) {
      workspaceId = pinned;
    }
  }

  // 3. 解析 SSH 主机
  const hosts = resolveSshHosts(workspaceId);
  if (hosts.length === 0) {
    await reportToolResultWithRetry(
      conversationId,
      toolCallId,
      JSON.stringify({
        ok: false,
        error: "未找到 SSH 主机",
        scope: workspaceId ? "workspace" : "global",
        workspaceId,
      }),
      false,
    );
    return;
  }

  // 4. 上限保护（sub-conv 最多 20，与 omni_spawn_sub_conversations 的 max_items 对齐）
  if (hosts.length > SSH_FLEET_HOST_LIMIT) {
    await reportToolResultWithRetry(
      conversationId,
      toolCallId,
      JSON.stringify({
        ok: false,
        error: `SSH 主机数 ${hosts.length} 超过子会话集群上限 ${SSH_FLEET_HOST_LIMIT}。请通过 workspace_id 限定工作区范围，或改用 omni_spawn_sub_conversations 手动指定子集。`,
        hostCount: hosts.length,
        limit: SSH_FLEET_HOST_LIMIT,
      }),
      false,
    );
    return;
  }

  // 5. 构造子会话规格（每台主机一个独立的 AI 子会话）
  const scopeLabel = workspaceId ? "工作区" : "全局";
  const specs: SubConversationSpawnSpec[] = hosts.map((h) => ({
    title: `体检 · ${h.name}`,
    task: [
      `请检查 SSH 主机 ${h.name}（resource_id: ${h.id}）的资源占用情况：`,
      `1. 调用 omni_ssh_get_stats（resource_id: ${h.id}）获取 CPU、内存、磁盘等基础指标`,
      `2. 分析各项指标是否正常（CPU > 80% 或 内存 > 85% 或 磁盘 > 90% 为高负载）`,
      `3. 给出简短健康评估和优化建议`,
      ``,
      `请用以下格式返回：`,
      `- 主机: ${h.name}`,
      `- 状态: 正常/警告/危险`,
      `- 关键指标: CPU x%, 内存 x%, 磁盘 x%`,
      `- 建议: ...`,
    ].join("\n"),
    resourceId: h.id,
  }));

  // 6. 集群标题
  const title = `SSH 体检（${scopeLabel}）· ${hosts.length} 台`;

  // 7. 委托共享逻辑
  return runSubConversationClusterFromSpecs({ conversationId, toolCallId, specs, title });
}
