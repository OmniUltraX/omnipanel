/**
 * 子会话集群取消传播。
 *
 * 三向取消联动：
 * 1. 取消集群（cancelCluster）→ 所有未完成子会话级联取消
 * 2. 取消单个子会话（cancelClusterChild）→ 仅该子会话取消，集群继续
 * 3. 取消父会话（cancelConversationClusters）→ 该会话下所有集群级联取消
 *
 * 实现：
 * - 每个集群持有一个 AbortController（模块级 Map）
 * - 子会话的 AbortController 监听集群 signal，集群 abort 时所有子会话 abort
 * - 同时调用 commands.aiChatCancel(conversationId) 通知后端停止 orchestrator
 * - 后端 ai_chat_cancel 会自动 resolve 该会话的所有 pending tool results
 */
import { commands } from "../../../ipc/bindings";
import { useAiOrchestrationStore } from "../../../stores/aiOrchestrationStore";
import { useAiStore } from "../../../stores/aiStore";
import type { SubConversationChildState } from "../aiMessageParts";

/** 集群级 AbortController（clusterId → controller） */
const clusterAbortControllers = new Map<string, AbortController>();

/** 子会话级 AbortController（conversationId → controller） */
const childAbortControllers = new Map<string, AbortController>();

/** 获取或创建集群的 AbortController */
export function getClusterAbortController(clusterId: string): AbortController {
  let controller = clusterAbortControllers.get(clusterId);
  if (!controller) {
    controller = new AbortController();
    clusterAbortControllers.set(clusterId, controller);
  }
  return controller;
}

/** 获取或创建子会话的 AbortController，并链接到集群 controller */
export function getChildAbortController(
  clusterId: string,
  childConversationId: string,
): AbortController {
  const existing = childAbortControllers.get(childConversationId);
  if (existing) return existing;

  const childController = new AbortController();
  const clusterController = getClusterAbortController(clusterId);

  // 集群 abort 时，级联 abort 子会话
  if (clusterController.signal.aborted) {
    childController.abort();
  } else {
    const onClusterAbort = () => childController.abort();
    clusterController.signal.addEventListener("abort", onClusterAbort, { once: true });
  }

  childAbortControllers.set(childConversationId, childController);
  return childController;
}

/** 取消整个集群：所有未完成子会话级联取消 */
export function cancelCluster(clusterId: string): void {
  const store = useAiOrchestrationStore.getState();
  const cluster = store.clusters[clusterId];
  if (!cluster) return;

  // 1. abort 集群 controller（级联到所有子会话）
  const controller = clusterAbortControllers.get(clusterId);
  if (controller && !controller.signal.aborted) {
    controller.abort();
  }

  // 2. 通知后端取消每个未完成子会话
  for (const child of cluster.children) {
    if (child.status === "pending" || child.status === "running") {
      void commands.aiChatCancel(child.conversationId).catch(() => {});
      childAbortControllers.delete(child.conversationId);
    }
  }

  // 3. 更新 store：集群 + 未完成子会话 → cancelled
  store.setClusterStatus(clusterId, "cancelled");
  for (const child of cluster.children) {
    if (child.status === "pending" || child.status === "running") {
      store.updateClusterChild(clusterId, child.conversationId, {
        status: "cancelled",
        finishedAt: Date.now(),
      });
    }
  }

  // 4. 同步到 message parts
  const { parentConversationId, parentMessageId } = cluster;
  if (parentConversationId && parentMessageId) {
    useAiStore.getState().setStreamClusterStatus(
      parentConversationId,
      parentMessageId,
      clusterId,
      "cancelled",
    );
  }

  // 5. 清理
  clusterAbortControllers.delete(clusterId);
}

/** 取消单个子会话：仅该子会话取消，集群继续运行其它子会话 */
export function cancelClusterChild(
  clusterId: string,
  childConversationId: string,
): void {
  const store = useAiOrchestrationStore.getState();
  const cluster = store.clusters[clusterId];
  if (!cluster) return;

  const child = cluster.children.find((c) => c.conversationId === childConversationId);
  if (!child || (child.status !== "pending" && child.status !== "running")) return;

  // 1. abort 子会话 controller
  const controller = childAbortControllers.get(childConversationId);
  if (controller && !controller.signal.aborted) {
    controller.abort();
  }
  childAbortControllers.delete(childConversationId);

  // 2. 通知后端取消
  void commands.aiChatCancel(childConversationId).catch(() => {});

  // 3. 更新 store
  store.updateClusterChild(clusterId, childConversationId, {
    status: "cancelled",
    finishedAt: Date.now(),
  });

  // 4. 同步到 message parts
  const { parentConversationId, parentMessageId } = cluster;
  if (parentConversationId && parentMessageId) {
    useAiStore.getState().updateStreamClusterChild(
      parentConversationId,
      parentMessageId,
      clusterId,
      childConversationId,
      { status: "cancelled", finishedAt: Date.now() },
    );
  }

  // 5. 检查是否所有子会话都已终止 → 更新集群状态
  checkClusterCompletion(clusterId);
}

/** 取消某父会话下所有集群（父会话取消时调用） */
export function cancelConversationClusters(parentConversationId: string): void {
  const clusters = useAiOrchestrationStore.getState().clusters;
  for (const cluster of Object.values(clusters)) {
    if (cluster.parentConversationId === parentConversationId) {
      cancelCluster(cluster.clusterId);
    }
  }
}

/** 取消所有仍在 running/pending 的集群（任务中心「取消全部」） */
export function cancelAllRunningClusters(): number {
  const clusters = useAiOrchestrationStore.getState().clusters;
  let cancelled = 0;
  for (const cluster of Object.values(clusters)) {
    if (cluster.status === "running" || cluster.status === "pending") {
      cancelCluster(cluster.clusterId);
      cancelled += 1;
    }
  }
  return cancelled;
}

/** 清理已终止集群的 abort controller（内存回收） */
export function cleanupClusterAbortController(clusterId: string): void {
  clusterAbortControllers.delete(clusterId);
}

/** 清理已终止子会话的 abort controller */
export function cleanupChildAbortController(childConversationId: string): void {
  childAbortControllers.delete(childConversationId);
}

/**
 * 检查集群是否所有子会话都已终止，如是则更新集群状态。
 * 在子会话完成 / 失败 / 取消时调用。
 */
export function checkClusterCompletion(clusterId: string): void {
  const store = useAiOrchestrationStore.getState();
  const cluster = store.clusters[clusterId];
  if (!cluster) return;
  if (cluster.status !== "running" && cluster.status !== "pending") return;

  const allTerminal = cluster.children.every(
    (c) =>
      c.status === "completed" ||
      c.status === "failed" ||
      c.status === "cancelled",
  );
  if (!allTerminal) return;

  const hasFailed = cluster.children.some((c) => c.status === "failed");
  const allCancelled = cluster.children.every((c) => c.status === "cancelled");

  // 状态推断：全部取消 → cancelled；有失败 → failed；否则 → completed
  const finalStatus: SubConversationChildState["status"] = allCancelled
    ? "cancelled"
    : hasFailed
      ? "failed"
      : "completed";

  store.setClusterStatus(clusterId, finalStatus);

  // 同步到 message parts
  const { parentConversationId, parentMessageId } = cluster;
  if (parentConversationId && parentMessageId) {
    useAiStore.getState().setStreamClusterStatus(
      parentConversationId,
      parentMessageId,
      clusterId,
      finalStatus,
    );
  }

  // 清理 abort controllers
  clusterAbortControllers.delete(clusterId);
  for (const child of cluster.children) {
    childAbortControllers.delete(child.conversationId);
  }
}
