/**
 * 快捷启动「询问 AI」会话历史：每条一次独立会话；非收藏最多保留 5 条。
 */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { createSafeLocalStorage } from "../lib/zustandPersistStorage";

export const QUICK_LAUNCHER_ASK_HISTORY_MAX_NORMAL = 5;

export interface QuickLauncherAskHistoryEntry {
  id: string;
  prompt: string;
  answer: string;
  createdAt: number;
  favorited: boolean;
}

interface QuickLauncherAskHistoryState {
  entries: QuickLauncherAskHistoryEntry[];
  /** 成功完成后追加一条新会话，并裁剪非收藏条目 */
  addEntry: (prompt: string, answer: string) => QuickLauncherAskHistoryEntry;
  removeEntry: (id: string) => void;
  toggleFavorite: (id: string) => void;
  /** 展示用：收藏优先，同组按时间新→旧 */
  listForDisplay: () => QuickLauncherAskHistoryEntry[];
}

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `ask-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** 收藏全部保留；非收藏只留最新 maxNormal 条 */
export function pruneAskHistoryEntries(
  entries: QuickLauncherAskHistoryEntry[],
  maxNormal = QUICK_LAUNCHER_ASK_HISTORY_MAX_NORMAL,
): QuickLauncherAskHistoryEntry[] {
  const favorited = entries.filter((e) => e.favorited);
  const normals = entries
    .filter((e) => !e.favorited)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, maxNormal);
  return [...favorited, ...normals].sort((a, b) => {
    if (a.favorited !== b.favorited) return a.favorited ? -1 : 1;
    return b.createdAt - a.createdAt;
  });
}

function sortForDisplay(entries: QuickLauncherAskHistoryEntry[]): QuickLauncherAskHistoryEntry[] {
  return [...entries].sort((a, b) => {
    if (a.favorited !== b.favorited) return a.favorited ? -1 : 1;
    return b.createdAt - a.createdAt;
  });
}

export const useQuickLauncherAskHistoryStore = create<QuickLauncherAskHistoryState>()(
  persist(
    (set, get) => ({
      entries: [],
      addEntry: (prompt, answer) => {
        const entry: QuickLauncherAskHistoryEntry = {
          id: newId(),
          prompt: prompt.trim(),
          answer: answer.trim(),
          createdAt: Date.now(),
          favorited: false,
        };
        set((state) => ({
          entries: pruneAskHistoryEntries([entry, ...state.entries]),
        }));
        return entry;
      },
      removeEntry: (id) => {
        set((state) => ({
          entries: state.entries.filter((e) => e.id !== id),
        }));
      },
      toggleFavorite: (id) => {
        set((state) => {
          const next = state.entries.map((e) =>
            e.id === id ? { ...e, favorited: !e.favorited } : e,
          );
          return { entries: pruneAskHistoryEntries(next) };
        });
      },
      listForDisplay: () => sortForDisplay(get().entries),
    }),
    {
      name: "omnipanel.quickLauncher.askHistory.v1",
      storage: createJSONStorage(createSafeLocalStorage),
      partialize: (s) => ({ entries: s.entries }),
      merge: (persisted, current) => {
        const raw = persisted as { entries?: QuickLauncherAskHistoryEntry[] } | undefined;
        const entries = Array.isArray(raw?.entries) ? raw.entries : current.entries;
        return {
          ...current,
          entries: pruneAskHistoryEntries(entries),
        };
      },
    },
  ),
);
