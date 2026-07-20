import { create } from "zustand";

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
  createTask: (task: Omit<AiTaskParent, "startedAt" | "status"> & { status?: AiTaskStatus }) => string;
  updateChild: (parentId: string, childId: string, patch: Partial<AiTaskChild>) => void;
  setParentStatus: (parentId: string, status: AiTaskStatus, resultSummary?: string) => void;
  cancelTask: (parentId: string) => void;
  removeTask: (parentId: string) => void;
}

let seq = 0;
function genId(prefix: string): string {
  return `${prefix}_${Date.now()}_${++seq}`;
}

export const useAiOrchestrationStore = create<AiOrchestrationState>((set, get) => ({
  tasks: {},
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
}));

export function genAiTaskId(prefix = "ai_task"): string {
  return genId(prefix);
}
