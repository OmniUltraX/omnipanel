import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { commands } from "../ipc/bindings";
import { unwrapCommand } from "../ipc/result";
import type { BackgroundTaskInfo, BackgroundTaskStatus } from "./backgroundTaskStore";

const HISTORY_LIMIT = 200;

interface BgTaskHistoryState {
  /** 终态被动任务（按 id） */
  history: Record<string, BackgroundTaskInfo>;
  hydrated: boolean;
  upsertHistory: (task: BackgroundTaskInfo) => void;
  hydrateFromBackend: () => Promise<void>;
  listHistory: () => BackgroundTaskInfo[];
}

function isTerminal(status: BackgroundTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function mergeHistory(
  current: Record<string, BackgroundTaskInfo>,
  incoming: BackgroundTaskInfo[],
): Record<string, BackgroundTaskInfo> {
  const next = { ...current };
  for (const task of incoming) {
    if (!isTerminal(task.status)) continue;
    next[task.id] = task;
  }
  const list = Object.values(next).sort(
    (a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt),
  );
  if (list.length <= HISTORY_LIMIT) return next;
  const trimmed: Record<string, BackgroundTaskInfo> = {};
  for (const item of list.slice(0, HISTORY_LIMIT)) trimmed[item.id] = item;
  return trimmed;
}

/** 被动任务终态历史：事件热路径写 local；启动时从 SQLite 水合 */
export const useBgTaskHistoryStore = create<BgTaskHistoryState>()(
  persist(
    (set, get) => ({
      history: {},
      hydrated: false,
      upsertHistory: (task) => {
        if (!isTerminal(task.status)) return;
        set((s) => ({ history: mergeHistory(s.history, [task]) }));
      },
      hydrateFromBackend: async () => {
        try {
          const rows = await unwrapCommand(commands.bgTaskHistoryList(HISTORY_LIMIT), {
            quiet: true,
          });
          const mapped: BackgroundTaskInfo[] = rows.map((r) => ({
            id: r.id,
            module: r.module,
            kind: r.kind,
            title: r.title,
            progress: r.progress,
            status: r.status as BackgroundTaskStatus,
            index: r.index,
            total: r.total,
            rowCompleted: r.rowCompleted ?? null,
            rowTotal: r.rowTotal ?? null,
            startedAt: r.startedAt ?? 0,
            finishedAt: r.finishedAt ?? null,
            error: r.error ?? null,
          }));
          set((s) => ({
            history: mergeHistory(s.history, mapped),
            hydrated: true,
          }));
        } catch {
          set({ hydrated: true });
        }
      },
      listHistory: () =>
        Object.values(get().history).sort(
          (a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt),
        ),
    }),
    {
      name: "omnipanel-bg-task-history.v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ history: s.history }),
    },
  ),
);
