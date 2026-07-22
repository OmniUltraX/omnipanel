import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { PlanData, PlanStep, PlanStepStatus } from "../lib/ai/aiMessageParts";

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
    }),
    {
      name: "omnipanel-ai-orchestration.v1",
      storage: createJSONStorage(() => localStorage),
      // 持久化 plans 和 tasks（tasks 旧逻辑不持久化，现在也一并持久化）
      partialize: (s) => ({ plans: s.plans, tasks: s.tasks }),
    },
  ),
);

export function genAiTaskId(prefix = "ai_task"): string {
  return genId(prefix);
}

export function genPlanId(): string {
  return genId("plan");
}

export function genStepId(): string {
  return genId("step");
}
