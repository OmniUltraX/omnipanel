import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { commands, type WorkflowExecution } from "../ipc/bindings";
import { WORKFLOW_EXECUTION_COMPLETE } from "../ipc/events";

export type LiveWorkflowExecution = WorkflowExecution & {
  /** 展示用标题（工作流名） */
  title?: string;
};

interface WorkflowLiveState {
  byId: Record<string, LiveWorkflowExecution>;
  upsert: (exec: LiveWorkflowExecution) => void;
  markComplete: (id: string) => Promise<void>;
}

export const useWorkflowLiveStore = create<WorkflowLiveState>((set, get) => ({
  byId: {},
  upsert: (exec) => set((s) => ({ byId: { ...s.byId, [exec.id]: exec } })),
  markComplete: async (id) => {
    try {
      const res = await commands.workflowGetExecution(id);
      if (res.status === "ok") {
        const cur = get().byId[id];
        set((s) => ({
          byId: {
            ...s.byId,
            [id]: {
              ...res.data.execution,
              title: cur?.title,
            },
          },
        }));
        return;
      }
    } catch {
      // ignore
    }
    set((s) => {
      const cur = s.byId[id];
      if (!cur) return s;
      return {
        byId: {
          ...s.byId,
          [id]: {
            ...cur,
            status: "failed",
            finished_at: Date.now(),
          },
        },
      };
    });
  },
}));

let workflowLiveInitialized = false;

/** Bootstrap：监听工作流执行完成，刷新 live 投影 */
export function initWorkflowLiveTasks() {
  if (workflowLiveInitialized) return;
  workflowLiveInitialized = true;
  void listen<string>(WORKFLOW_EXECUTION_COMPLETE, (event) => {
    const id = event.payload;
    if (id) void useWorkflowLiveStore.getState().markComplete(id);
  }).catch(() => {});
}
