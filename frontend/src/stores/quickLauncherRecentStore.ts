import { create } from "zustand";
import { persist } from "zustand/middleware";

/** 与快捷启动可激活目标对齐的最近打开项 */
export type QuickLaunchRecentTarget =
  | { type: "ssh-connection"; connectionId: string }
  | { type: "db-connection"; connectionId: string }
  | { type: "db-database"; connectionId: string; database: string }
  | { type: "db-table"; connectionId: string; database: string; table: string };

export interface QuickLaunchRecentEntry {
  key: string;
  target: QuickLaunchRecentTarget;
  /** 打开时的展示名快照（连接改名后仍可读） */
  label: string;
  useCount: number;
  lastUsedAt: number;
}

const MAX_ENTRIES = 40;

export function quickLaunchRecentKey(target: QuickLaunchRecentTarget): string {
  switch (target.type) {
    case "ssh-connection":
      return `ssh:${target.connectionId}`;
    case "db-connection":
      return `db-conn:${target.connectionId}`;
    case "db-database":
      return `db-database:${target.connectionId}:${target.database}`;
    case "db-table":
      return `db-table:${target.connectionId}:${target.database}:${target.table}`;
  }
}

interface QuickLauncherRecentState {
  entries: QuickLaunchRecentEntry[];
  /** 记录一次打开：次数 +1，时间刷新 */
  recordOpen: (target: QuickLaunchRecentTarget, label: string) => void;
  /** 次数降序，次数相同则时间越晚越前 */
  getSortedEntries: () => QuickLaunchRecentEntry[];
  clear: () => void;
}

function sortRecentEntries(entries: QuickLaunchRecentEntry[]): QuickLaunchRecentEntry[] {
  return [...entries].sort((a, b) => {
    if (b.useCount !== a.useCount) return b.useCount - a.useCount;
    return b.lastUsedAt - a.lastUsedAt;
  });
}

export const useQuickLauncherRecentStore = create<QuickLauncherRecentState>()(
  persist(
    (set, get) => ({
      entries: [],
      recordOpen: (target, label) => {
        const key = quickLaunchRecentKey(target);
        const trimmedLabel = label.trim() || key;
        set((state) => {
          const prev = state.entries.find((e) => e.key === key);
          const next: QuickLaunchRecentEntry = {
            key,
            target,
            label: trimmedLabel,
            useCount: (prev?.useCount ?? 0) + 1,
            lastUsedAt: Date.now(),
          };
          const rest = state.entries.filter((e) => e.key !== key);
          return { entries: [next, ...rest].slice(0, MAX_ENTRIES) };
        });
      },
      getSortedEntries: () => sortRecentEntries(get().entries),
      clear: () => set({ entries: [] }),
    }),
    { name: "omnipanel.quickLauncher.recent" },
  ),
);
