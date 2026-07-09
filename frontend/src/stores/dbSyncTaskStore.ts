import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import type {
  SyncTask,
  SyncTaskAnalysisRecord,
  SyncTaskConfig,
  SyncTaskRunRecord,
  ToolboxTabId,
} from "../modules/database/toolbox/types";

const STORAGE_KEY = "omnipanel-db-sync-tasks.v1";
const MAX_RUNS_PER_TASK = 100;

function makeId(): string {
  return `sync-task:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

export interface PendingSyncTaskLoad {
  taskId: string;
  runAfterLoad: boolean;
  nonce: number;
}

interface DbSyncTaskState {
  tasks: SyncTask[];
  runHistory: Record<string, SyncTaskRunRecord[]>;
  analysisHistory: Record<string, SyncTaskAnalysisRecord[]>;
  activeTaskId: string | null;
  pendingLoad: PendingSyncTaskLoad | null;
  addTask: (input: { name: string; kind: ToolboxTabId; config: SyncTaskConfig }) => SyncTask;
  updateTask: (id: string, patch: { name?: string; kind?: ToolboxTabId; config?: SyncTaskConfig }) => void;
  addRunRecord: (taskId: string, record: SyncTaskRunRecord) => void;
  addAnalysisRecord: (taskId: string, record: SyncTaskAnalysisRecord) => void;
  updateRunByBgTaskId: (bgTaskId: string, patch: Partial<SyncTaskRunRecord>) => void;
  getRunsForTask: (taskId: string) => SyncTaskRunRecord[];
  getAnalysisForTask: (taskId: string) => SyncTaskAnalysisRecord[];
  clearRunHistory: (taskId: string) => void;
  clearAnalysisHistory: (taskId: string) => void;
  deleteTask: (id: string) => void;
  setActiveTaskId: (id: string | null) => void;
  requestLoad: (taskId: string, runAfterLoad?: boolean) => void;
  clearPendingLoad: () => void;
}

export const useDbSyncTaskStore = create<DbSyncTaskState>()(
  persist(
    (set, get) => ({
      tasks: [],
      runHistory: {},
      analysisHistory: {},
      activeTaskId: null,
      pendingLoad: null,
      addTask: ({ name, kind, config }) => {
        const now = Date.now();
        const task: SyncTask = {
          id: makeId(),
          name: name.trim(),
          kind,
          config,
          createdAt: now,
          updatedAt: now,
        };
        set((state) => ({
          tasks: [task, ...state.tasks],
          activeTaskId: task.id,
        }));
        return task;
      },
      updateTask: (id, patch) => {
        set((state) => {
          const task = state.tasks.find((item) => item.id === id);
          if (!task) {
            return state;
          }
          const nextName = patch.name?.trim() ?? task.name;
          const nextKind = patch.kind ?? task.kind;
          const nextConfig = patch.config ?? task.config;
          if (
            nextName === task.name &&
            nextKind === task.kind &&
            JSON.stringify(nextConfig) === JSON.stringify(task.config)
          ) {
            return state;
          }
          return {
            tasks: state.tasks.map((item) =>
              item.id === id
                ? {
                    ...item,
                    name: nextName,
                    kind: nextKind,
                    config: nextConfig,
                    updatedAt: Date.now(),
                  }
                : item,
            ),
          };
        });
      },
      addRunRecord: (taskId, record) => {
        set((state) => {
          const prev = state.runHistory[taskId] ?? [];
          const next = [record, ...prev].slice(0, MAX_RUNS_PER_TASK);
          return {
            runHistory: { ...state.runHistory, [taskId]: next },
          };
        });
      },
      addAnalysisRecord: (taskId, record) => {
        set((state) => {
          const prev = state.analysisHistory[taskId] ?? [];
          const next = [record, ...prev].slice(0, MAX_RUNS_PER_TASK);
          return {
            analysisHistory: { ...state.analysisHistory, [taskId]: next },
          };
        });
      },
      updateRunByBgTaskId: (bgTaskId, patch) => {
        set((state) => {
          let changed = false;
          const runHistory = { ...state.runHistory };
          for (const [taskId, runs] of Object.entries(runHistory)) {
            const index = runs.findIndex((run) => run.bgTaskId === bgTaskId);
            if (index < 0) {
              continue;
            }
            const updated = [...runs];
            updated[index] = { ...updated[index], ...patch };
            runHistory[taskId] = updated;
            changed = true;
            break;
          }
          return changed ? { runHistory } : state;
        });
      },
      getRunsForTask: (taskId) => get().runHistory[taskId] ?? [],
      getAnalysisForTask: (taskId) => get().analysisHistory[taskId] ?? [],
      clearRunHistory: (taskId) => {
        set((state) => {
          if (!state.runHistory[taskId]?.length) {
            return state;
          }
          const { [taskId]: _removed, ...runHistory } = state.runHistory;
          return { runHistory };
        });
      },
      clearAnalysisHistory: (taskId) => {
        set((state) => {
          if (!state.analysisHistory[taskId]?.length) {
            return state;
          }
          const { [taskId]: _removed, ...analysisHistory } = state.analysisHistory;
          return { analysisHistory };
        });
      },
      deleteTask: (id) => {
        set((state) => {
          const { [id]: _removedRuns, ...runHistory } = state.runHistory;
          const { [id]: _removedAnalysis, ...analysisHistory } = state.analysisHistory;
          return {
            tasks: state.tasks.filter((task) => task.id !== id),
            runHistory,
            analysisHistory,
            activeTaskId: state.activeTaskId === id ? null : state.activeTaskId,
            pendingLoad: state.pendingLoad?.taskId === id ? null : state.pendingLoad,
          };
        });
      },
      setActiveTaskId: (activeTaskId) => set({ activeTaskId }),
      requestLoad: (taskId, runAfterLoad = false) => {
        if (!get().tasks.some((task) => task.id === taskId)) {
          return;
        }
        const pendingLoad = {
          taskId,
          runAfterLoad,
          nonce: Date.now(),
        };
        set({ pendingLoad });
      },
      clearPendingLoad: () => {
        set({ pendingLoad: null });
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        tasks: state.tasks,
        runHistory: state.runHistory,
        analysisHistory: state.analysisHistory,
      }),
    },
  ),
);
