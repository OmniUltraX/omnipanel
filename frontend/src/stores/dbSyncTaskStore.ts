import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import type { SyncTask, SyncTaskConfig, ToolboxTabId } from "../modules/database/toolbox/types";

const STORAGE_KEY = "omnipanel-db-sync-tasks.v1";

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
  activeTaskId: string | null;
  pendingLoad: PendingSyncTaskLoad | null;
  addTask: (input: { name: string; kind: ToolboxTabId; config: SyncTaskConfig }) => SyncTask;
  deleteTask: (id: string) => void;
  setActiveTaskId: (id: string | null) => void;
  requestLoad: (taskId: string, runAfterLoad?: boolean) => void;
  clearPendingLoad: () => void;
}

export const useDbSyncTaskStore = create<DbSyncTaskState>()(
  persist(
    (set, get) => ({
      tasks: [],
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
      deleteTask: (id) => {
        set((state) => ({
          tasks: state.tasks.filter((task) => task.id !== id),
          activeTaskId: state.activeTaskId === id ? null : state.activeTaskId,
          pendingLoad: state.pendingLoad?.taskId === id ? null : state.pendingLoad,
        }));
      },
      setActiveTaskId: (activeTaskId) => set({ activeTaskId }),
      requestLoad: (taskId, runAfterLoad = false) => {
        if (!get().tasks.some((task) => task.id === taskId)) {
          return;
        }
        set({
          pendingLoad: {
            taskId,
            runAfterLoad,
            nonce: Date.now(),
          },
        });
      },
      clearPendingLoad: () => set({ pendingLoad: null }),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        tasks: state.tasks,
      }),
    },
  ),
);
