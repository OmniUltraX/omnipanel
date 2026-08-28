import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { createSafeLocalStorage } from "../lib/zustandPersistStorage";
import {
  commands,
  type Workflow,
  type WorkflowDetail,
  type WorkflowExecution,
  type SaveWorkflowRequest,
} from "../ipc/bindings";

interface WorkflowStore {
  // ── 数据 ──────────────────────────────────────────────
  workflows: Workflow[];
  selectedDetail: WorkflowDetail | null;
  executions: WorkflowExecution[];

  // ── UI 状态 ──────────────────────────────────────────
  selectedWorkflowId: string | null;
  isLoading: boolean;
  error: string | null;

  // ── 数据操作 ─────────────────────────────────────────
  loadWorkflows: () => Promise<void>;
  getWorkflow: (id: string) => Promise<WorkflowDetail | null>;
  saveWorkflow: (req: SaveWorkflowRequest) => Promise<WorkflowDetail | null>;
  deleteWorkflow: (id: string) => Promise<void>;
  loadExecutions: (workflowId: string, limit?: number) => Promise<void>;

  // ── UI 操作 ──────────────────────────────────────────
  selectWorkflow: (id: string | null) => void;
  clearError: () => void;
}

export const useWorkflowStore = create<WorkflowStore>()(
  persist(
    (set, get) => ({
      // ── 数据 ─────────────────────────────────────────
      workflows: [],
      selectedDetail: null,
      executions: [],

      // ── UI 状态 ──────────────────────────────────────
      selectedWorkflowId: null,
      isLoading: false,
      error: null,

      // ── 数据操作 ─────────────────────────────────────

      loadWorkflows: async () => {
        set({ isLoading: true, error: null });
        try {
          const res = await commands.workflowList();
          if (res.status === "ok") {
            set({ workflows: res.data, isLoading: false });
          } else {
            set({ error: res.error.message, isLoading: false });
          }
        } catch (e) {
          set({ error: String(e), isLoading: false });
        }
      },

      getWorkflow: async (id: string) => {
        try {
          const res = await commands.workflowGet(id);
          if (res.status === "ok") {
            set({ selectedDetail: res.data });
            return res.data;
          }
          set({ error: res.error.message });
          return null;
        } catch (e) {
          set({ error: String(e) });
          return null;
        }
      },

      saveWorkflow: async (req: SaveWorkflowRequest) => {
        try {
          const res = await commands.workflowSave(req);
          if (res.status === "ok") {
            await get().loadWorkflows();
            set({ selectedDetail: res.data, selectedWorkflowId: res.data.workflow.id });
            return res.data;
          }
          set({ error: res.error.message });
          return null;
        } catch (e) {
          set({ error: String(e) });
          return null;
        }
      },

      deleteWorkflow: async (id: string) => {
        try {
          const res = await commands.workflowDelete(id);
          if (res.status === "ok") {
            set((state) => ({
              workflows: state.workflows.filter((w) => w.id !== id),
              selectedWorkflowId:
                state.selectedWorkflowId === id ? null : state.selectedWorkflowId,
              selectedDetail:
                state.selectedDetail?.workflow.id === id
                  ? null
                  : state.selectedDetail,
            }));
          } else {
            set({ error: res.error.message });
          }
        } catch (e) {
          set({ error: String(e) });
        }
      },

      loadExecutions: async (workflowId: string, limit = 50) => {
        try {
          const res = await commands.workflowExecutions(workflowId, limit);
          if (res.status === "ok") {
            set({ executions: res.data });
          } else {
            set({ error: res.error.message });
          }
        } catch (e) {
          set({ error: String(e) });
        }
      },

      // ── UI 操作 ──────────────────────────────────────

      selectWorkflow: async (id: string | null) => {
        set({ selectedWorkflowId: id, selectedDetail: null, executions: [] });
        if (id) {
          const detail = await get().getWorkflow(id);
          if (detail) {
            await get().loadExecutions(id);
          }
        }
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: "omnipanel-workflow-store",
      storage: createJSONStorage(createSafeLocalStorage),
      partialize: (state) => ({
        selectedWorkflowId: state.selectedWorkflowId,
      }),
    }
  )
);
