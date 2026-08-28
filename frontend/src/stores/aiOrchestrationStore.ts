import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { createSafeLocalStorage } from "../lib/zustandPersistStorage";
import type {
  PlanData,
  PlanStep,
  PlanStepStatus,
  SubConversationChildState,
  SubConversationClusterStatus,
} from "../lib/ai/aiMessageParts";

export type AiTaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface AiTaskChild {
  id: string;
  title: string;
  status: AiTaskStatus;
  summary?: string;
  error?: string;
  resourceId?: string;
}

export interface AiTaskParent {
  id: string;
  conversationId: string | null;
  title: string;
  kind: string;
  status: AiTaskStatus;
  children: AiTaskChild[];
  startedAt: number;
  finishedAt?: number;
  resultSummary?: string;
}

interface AiOrchestrationState {
  tasks: Record<string, AiTaskParent>;
  /** AI 自主规划的任务计划，按 planId 索引 */
  plans: Record<string, PlanData>;
  /** 子会话集群运行时状态（clusterId → 状态）；与 message parts 中的 cluster part 镜像，
   *  便于跨组件订阅（顶部 Plan/任务中心无需深挖 message parts）。 */
  clusters: Record<string, SubConversationClusterRuntime>;
  createTask: (task: Omit<AiTaskParent, "startedAt" | "status"> & { status?: AiTaskStatus }) => string;
  updateChild: (parentId: string, childId: string, patch: Partial<AiTaskChild>) => void;
  setParentStatus: (parentId: string, status: AiTaskStatus, resultSummary?: string) => void;
  cancelTask: (parentId: string) => void;
  removeTask: (parentId: string) => void;
  // Plan 管理
  createPlan: (plan: PlanData) => void;
  updatePlan: (planId: string, patch: Partial<Omit<PlanData, "id">>) => void;
  updatePlanStep: (planId: string, stepId: string, patch: Partial<PlanStep>) => void;
  addPlanStep: (planId: string, step: PlanStep, afterStepId?: string) => void;
  removePlan: (planId: string) => void;
  /** 当工具调用完成时，自动更新关联的 plan step 状态 */
  syncStepFromToolCall: (planId: string, stepId: string, status: PlanStepStatus, summary?: string, error?: string) => void;
  // 子会话集群管理
  createCluster: (cluster: SubConversationClusterRuntime) => void;
  updateCluster: (clusterId: string, patch: Partial<Omit<SubConversationClusterRuntime, "clusterId">>) => void;
  updateClusterChild: (clusterId: string, conversationId: string, patch: Partial<SubConversationChildState>) => void;
  setClusterStatus: (clusterId: string, status: SubConversationClusterStatus, aggregatedResult?: string) => void;
  removeCluster: (clusterId: string) => void;
}

/** 子会话集群运行时状态（store 端镜像） */
export interface SubConversationClusterRuntime {
  clusterId: string;
  title: string;
  toolCallId: string;
  /** 父会话 id */
  parentConversationId: string;
  /** 父消息 id（cluster part 所在 message） */
  parentMessageId: string;
  status: SubConversationClusterStatus;
  children: SubConversationChildState[];
  aggregatedResult?: string;
  createdAt: number;
  finishedAt?: number;
}

let seq = 0;
function genId(prefix: string): string {
  return `${prefix}_${Date.now()}_${++seq}`;
}

export const useAiOrchestrationStore = create<AiOrchestrationState>()(
  persist(
    (set, get) => ({
      tasks: {},
      plans: {},
      clusters: {},
      createTask: (task) => {
        const id = task.id || genId("ai_task");
        set((s) => ({
          tasks: {
            ...s.tasks,
            [id]: {
              ...task,
              id,
              status: task.status ?? "running",
              startedAt: Date.now(),
            },
          },
        }));
        return id;
      },
      updateChild: (parentId, childId, patch) =>
        set((s) => {
          const parent = s.tasks[parentId];
          if (!parent) return s;
          return {
            tasks: {
              ...s.tasks,
              [parentId]: {
                ...parent,
                children: parent.children.map((c) =>
                  c.id === childId ? { ...c, ...patch } : c,
                ),
              },
            },
          };
        }),
      setParentStatus: (parentId, status, resultSummary) =>
        set((s) => {
          const parent = s.tasks[parentId];
          if (!parent) return s;
          return {
            tasks: {
              ...s.tasks,
              [parentId]: {
                ...parent,
                status,
                resultSummary,
                finishedAt:
                  status === "running" || status === "pending" ? undefined : Date.now(),
              },
            },
          };
        }),
      cancelTask: (parentId) => {
        const parent = get().tasks[parentId];
        if (!parent) return;
        set((s) => ({
          tasks: {
            ...s.tasks,
            [parentId]: {
              ...parent,
              status: "cancelled",
              finishedAt: Date.now(),
              children: parent.children.map((c) =>
                c.status === "pending" || c.status === "running"
                  ? { ...c, status: "cancelled" as const }
                  : c,
              ),
            },
          },
        }));
      },
      removeTask: (parentId) =>
        set((s) => {
          const next = { ...s.tasks };
          delete next[parentId];
          return { tasks: next };
        }),
      // === Plan 管理 ===
      createPlan: (plan) =>
        set((s) => ({
          plans: { ...s.plans, [plan.id]: plan },
        })),
      updatePlan: (planId, patch) =>
        set((s) => {
          const plan = s.plans[planId];
          if (!plan) return s;
          return {
            plans: {
              ...s.plans,
              [planId]: { ...plan, ...patch, updatedAt: Date.now() },
            },
          };
        }),
      updatePlanStep: (planId, stepId, patch) =>
        set((s) => {
          const plan = s.plans[planId];
          if (!plan) return s;
          return {
            plans: {
              ...s.plans,
              [planId]: {
                ...plan,
                updatedAt: Date.now(),
                steps: plan.steps.map((step) =>
                  step.id === stepId ? { ...step, ...patch } : step,
                ),
              },
            },
          };
        }),
      addPlanStep: (planId, step, afterStepId) =>
        set((s) => {
          const plan = s.plans[planId];
          if (!plan) return s;
          const steps = [...plan.steps];
          if (afterStepId) {
            const idx = steps.findIndex((st) => st.id === afterStepId);
            if (idx >= 0) {
              steps.splice(idx + 1, 0, step);
            } else {
              steps.push(step);
            }
          } else {
            steps.push(step);
          }
          return {
            plans: {
              ...s.plans,
              [planId]: { ...plan, steps, updatedAt: Date.now() },
            },
          };
        }),
      removePlan: (planId) =>
        set((s) => {
          const next = { ...s.plans };
          delete next[planId];
          return { plans: next };
        }),
      syncStepFromToolCall: (planId, stepId, status, summary, error) =>
        set((s) => {
          const plan = s.plans[planId];
          if (!plan) return s;
          const steps = plan.steps.map((step) =>
            step.id === stepId
              ? { ...step, status, ...(summary !== undefined ? { summary } : {}), ...(error !== undefined ? { error } : {}) }
              : step,
          );
          // 自动推断整体状态：全部完成则 completed，任一失败则 failed
          const allDone = steps.every((st) => st.status === "completed" || st.status === "skipped");
          const anyFailed = steps.some((st) => st.status === "failed");
          const planStatus: PlanData["status"] = anyFailed
            ? "failed"
            : allDone
              ? "completed"
              : "executing";
          return {
            plans: {
              ...s.plans,
              [planId]: { ...plan, steps, status: planStatus, updatedAt: Date.now() },
            },
          };
        }),
      // === 子会话集群管理 ===
      createCluster: (cluster) =>
        set((s) => ({
          clusters: { ...s.clusters, [cluster.clusterId]: cluster },
        })),
      updateCluster: (clusterId, patch) =>
        set((s) => {
          const c = s.clusters[clusterId];
          if (!c) return s;
          return {
            clusters: {
              ...s.clusters,
              [clusterId]: { ...c, ...patch },
            },
          };
        }),
      updateClusterChild: (clusterId, conversationId, patch) =>
        set((s) => {
          const c = s.clusters[clusterId];
          if (!c) return s;
          return {
            clusters: {
              ...s.clusters,
              [clusterId]: {
                ...c,
                children: c.children.map((child) =>
                  child.conversationId === conversationId
                    ? { ...child, ...patch }
                    : child,
                ),
              },
            },
          };
        }),
      setClusterStatus: (clusterId, status, aggregatedResult) =>
        set((s) => {
          const c = s.clusters[clusterId];
          if (!c) return s;
          return {
            clusters: {
              ...s.clusters,
              [clusterId]: {
                ...c,
                status,
                ...(aggregatedResult !== undefined ? { aggregatedResult } : {}),
                finishedAt:
                  status === "running" || status === "pending"
                    ? undefined
                    : Date.now(),
              },
            },
          };
        }),
      removeCluster: (clusterId) =>
        set((s) => {
          const next = { ...s.clusters };
          delete next[clusterId];
          return { clusters: next };
        }),
    }),
    {
      name: "omnipanel-ai-orchestration.v1",
      storage: createJSONStorage(createSafeLocalStorage),
      // 持久化 plans/tasks/clusters；但 loop kind 的 task 不持久化——它由 loopRunner
      // 的模块级 timer 驱动，timer 本身不持久化，task 持久化会造成重启后僵尸态。
      partialize: (s) => ({
        plans: s.plans,
        tasks: Object.fromEntries(
          Object.entries(s.tasks).filter(([_, t]) => t.kind !== "loop"),
        ),
        clusters: s.clusters,
      }),
      // 双保险：旧版本持久化的 loop task 仍可能被 rehydrate 进来，强制收口为 cancelled；
      // 同理，running/pending 的 cluster 也收口为 cancelled（重启即视为放弃运行中的子会话集群）。
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const now = Date.now();
        if (state.tasks) {
          for (const [id, task] of Object.entries(state.tasks)) {
            if (task.kind !== "loop") continue;
            if (task.status === "running" || task.status === "pending") {
              state.tasks[id] = {
                ...task,
                status: "cancelled",
                finishedAt: now,
                children: task.children.map((c) =>
                  c.status === "running" || c.status === "pending"
                    ? { ...c, status: "cancelled" as const }
                    : c,
                ),
              };
            }
          }
        }
        if (state.clusters) {
          for (const [id, cluster] of Object.entries(state.clusters)) {
            if (cluster.status === "running" || cluster.status === "pending") {
              state.clusters[id] = {
                ...cluster,
                status: "cancelled",
                finishedAt: now,
                children: cluster.children.map((c) =>
                  c.status === "running" || c.status === "pending"
                    ? { ...c, status: "cancelled" as const }
                    : c,
                ),
              };
            }
          }
        }
      },
    },
  ),
);

export function genAiTaskId(prefix = "ai_task"): string {
  return genId(prefix);
}
