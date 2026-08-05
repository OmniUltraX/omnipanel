import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { commands } from "../ipc/bindings";
import { unwrapCommand } from "../ipc/result";
import { refreshConnectionPool } from "./connectionPoolStore";
import {
  initKnowledgeVectorizeBackgroundTasks,
} from "../modules/knowledge/knowledgeVectorize";
import { initSchemaCacheBackgroundTasks } from "../modules/database/schema/schemaCacheBackgroundTasks";
import { initDbSyncTaskRunTracking } from "./dbSyncTaskRunTracking";
import { useBgTaskHistoryStore } from "./bgTaskHistoryStore";
import { initWorkflowLiveTasks } from "./workflowLiveStore";
import { ensureFileTransferListener } from "./fileManagerStore";

export type BackgroundTaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface BackgroundTaskInfo {
  id: string;
  module: string;
  kind: string;
  title: string;
  progress: string;
  status: BackgroundTaskStatus;
  index: number;
  total: number;
  rowCompleted?: number | null;
  rowTotal?: number | null;
  startedAt: number;
  finishedAt?: number | null;
  error?: string | null;
}

interface BackgroundTaskState {
  tasks: Record<string, BackgroundTaskInfo>;
  taskListOpen: boolean;
  upsertTask: (task: BackgroundTaskInfo) => void;
  removeTask: (id: string) => void;
  setTaskListOpen: (open: boolean) => void;
  refreshRunning: () => Promise<void>;
}

export const useBackgroundTaskStore = create<BackgroundTaskState>((set) => ({
  tasks: {},
  taskListOpen: false,

  upsertTask: (task) =>
    set((state) => ({
      tasks: { ...state.tasks, [task.id]: task },
    })),

  removeTask: (id) =>
    set((state) => {
      const next = { ...state.tasks };
      delete next[id];
      return { tasks: next };
    }),

  setTaskListOpen: (open) => set({ taskListOpen: open }),

  refreshRunning: async () => {
    try {
      const list = await invoke<BackgroundTaskInfo[]>("bg_task_list");
      set((state) => {
        const next = { ...state.tasks };
        for (const task of list) {
          next[task.id] = task;
        }
        return { tasks: next };
      });
    } catch {
      // Tauri 未就绪时忽略
    }
  },
}));

export function getRunningBackgroundTasks(): BackgroundTaskInfo[] {
  return Object.values(useBackgroundTaskStore.getState().tasks).filter((task) =>
    task.status === "pending" || task.status === "running",
  );
}

export async function cancelBackgroundTask(id: string): Promise<void> {
  const local = localTaskCancelHandlers.get(id);
  if (local) {
    local();
    return;
  }
  await unwrapCommand(commands.bgTaskCancel(id));
}

/** 前端本地任务取消句柄（不经 Tauri bg_task）。 */
const localTaskCancelHandlers = new Map<string, () => void>();

export function registerLocalBackgroundTaskCancel(
  id: string,
  onCancel: () => void,
): () => void {
  localTaskCancelHandlers.set(id, onCancel);
  return () => {
    localTaskCancelHandlers.delete(id);
  };
}

/** 创建/更新前端本地后台任务，并可选记入历史。 */
export function upsertLocalBackgroundTask(task: BackgroundTaskInfo): void {
  useBackgroundTaskStore.getState().upsertTask(task);
  if (
    task.status === "completed" ||
    task.status === "failed" ||
    task.status === "cancelled"
  ) {
    useBgTaskHistoryStore.getState().upsertHistory(task);
    window.setTimeout(() => {
      useBackgroundTaskStore.getState().removeTask(task.id);
    }, 8000);
  }
}

export async function cancelAllRunningBackgroundTasks(): Promise<void> {
  const tasks = getRunningBackgroundTasks();
  await Promise.all(tasks.map((task) => cancelBackgroundTask(task.id)));
}

export async function submitDbDataSyncAnalysis(
  source: unknown,
  target: unknown,
  tables: unknown[],
  ignoredFields: string[] = [],
): Promise<string> {
  return invoke<string>("bg_task_submit_db_data_sync", {
    source,
    target,
    tables,
    ignoredFields,
  });
}

export async function submitDbSchemaSyncAnalysis(
  target: unknown,
  targetSchema: string,
  tables: unknown[],
): Promise<string> {
  return invoke<string>("bg_task_submit_db_schema_sync", {
    target,
    targetSchema,
    tables,
  });
}

export async function submitKnowledgeVectorize(args: unknown): Promise<string> {
  return invoke<string>("bg_task_submit_knowledge_vectorize", { args });
}

export async function submitOllamaInstall(): Promise<string> {
  return invoke<string>("bg_task_submit_ollama_install");
}

export async function submitOllamaPull(model: string): Promise<string> {
  return invoke<string>("bg_task_submit_ollama_pull", { model });
}

export async function submitDbSchemaCacheRefresh(
  connectionIds: string[] | null,
): Promise<string> {
  return invoke<string>("bg_task_submit_db_schema_cache_refresh", {
    connectionIds,
  });
}

export async function submitDbDataSyncExecute(
  source: unknown,
  target: unknown,
  tables: unknown[],
): Promise<string> {
  return invoke<string>("bg_task_submit_db_data_sync_execute", {
    source,
    target,
    tables,
  });
}

export async function submitDbDataSyncSqlExecute(
  target: unknown,
  sqlFilePath: string,
  tableNames: string[],
): Promise<string> {
  return invoke<string>("bg_task_submit_db_data_sync_sql_execute", {
    target,
    sqlFilePath,
    tableNames,
  });
}

export async function submitDbSchemaSyncExecute(
  source: unknown,
  target: unknown,
  tables: unknown[],
): Promise<string> {
  return invoke<string>("bg_task_submit_db_schema_sync_execute", {
    source,
    target,
    tables,
  });
}

let bgTaskInitialized = false;

/** 订阅后台任务事件，在 Bootstrap 中调用一次。 */
export function initBackgroundTasks() {
  if (bgTaskInitialized) return;
  bgTaskInitialized = true;

  void useBackgroundTaskStore.getState().refreshRunning();
  void useBgTaskHistoryStore.getState().hydrateFromBackend();
  initKnowledgeVectorizeBackgroundTasks();
  initSchemaCacheBackgroundTasks();
  initDbSyncTaskRunTracking();
  initWorkflowLiveTasks();
  // 文件传输任务接入后台任务系统（左下角状态栏 + 后台任务弹窗）
  void ensureFileTransferListener();

  const unsubs: Array<() => void> = [];

  listen<BackgroundTaskInfo>("bg-task-update", (event) => {
    const task = event.payload;
    useBackgroundTaskStore.getState().upsertTask(task);
    if (
      task.status === "completed" ||
      task.status === "failed" ||
      task.status === "cancelled"
    ) {
      useBgTaskHistoryStore.getState().upsertHistory(task);
      window.setTimeout(() => {
        useBackgroundTaskStore.getState().removeTask(task.id);
        void refreshConnectionPool();
      }, 8000);
    }
    void refreshConnectionPool();
  })
    .then((fn) => unsubs.push(fn))
    .catch(() => {});

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      for (const fn of unsubs) fn();
    });
  }
}

export function useRunningBackgroundTasks(): BackgroundTaskInfo[] {
  const tasks = useBackgroundTaskStore((s) => s.tasks);
  return Object.values(tasks)
    .filter((task) => task.status === "pending" || task.status === "running")
    .sort((a, b) => a.startedAt - b.startedAt);
}

/** 状态栏展示：优先运行中任务，否则展示刚结束的任务（完成/失败）。 */
export function getPrimaryBackgroundTaskForStatusBar(
  tasks: Record<string, BackgroundTaskInfo>,
): BackgroundTaskInfo | null {
  const list = Object.values(tasks);
  const running = list
    .filter((task) => task.status === "pending" || task.status === "running")
    .sort((a, b) => a.startedAt - b.startedAt);
  if (running.length > 0) {
    return running[0] ?? null;
  }
  const recent = list
    .filter((task) => task.status === "completed" || task.status === "failed")
    .sort((a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt));
  return recent[0] ?? null;
}

export function countRunningBackgroundTasks(tasks: Record<string, BackgroundTaskInfo>): number {
  return Object.values(tasks).filter(
    (task) => task.status === "pending" || task.status === "running",
  ).length;
}

type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

/** 格式化后台任务在状态栏/任务面板的进度文案。 */
export function formatBackgroundTaskStatusMessage(
  task: BackgroundTaskInfo,
  runningCount: number,
  t: TranslateFn,
): string {
  const errorText = task.error?.trim() ?? "";
  let message =
    task.status === "failed" && errorText
      ? `${task.title}：${errorText}`
      : task.progress.trim() || task.title;
  if (task.rowTotal != null && task.rowTotal > 0 && task.status !== "failed") {
    message += ` · ${t("shell.backgroundTasks.rowProgress", {
      completed: String(task.rowCompleted ?? 0),
      total: String(task.rowTotal),
    })}`;
  }
  if (runningCount > 1) {
    message += ` · ${t("shell.backgroundTasks.runningCount", { count: runningCount })}`;
  }
  return message;
}

export function backgroundTaskStatusBarLevel(
  status: BackgroundTaskInfo["status"],
): "progress" | "success" | "error" {
  if (status === "completed") return "success";
  if (status === "failed" || status === "cancelled") return "error";
  return "progress";
}
