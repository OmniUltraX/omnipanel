import { create } from "zustand";
import { persist } from "zustand/middleware";

interface QuickLauncherActionStatsState {
  /** actionKey → 使用次数 */
  useCounts: Record<string, number>;
  recordUse: (actionKey: string) => void;
}

/** 智能建议动作使用频次（跨窗口 localStorage；子窗独立 profile 时各自一份，可接受） */
export const useQuickLauncherActionStatsStore = create<QuickLauncherActionStatsState>()(
  persist(
    (set) => ({
      useCounts: {},
      recordUse: (actionKey) => {
        const key = actionKey.trim();
        if (!key) return;
        set((state) => ({
          useCounts: {
            ...state.useCounts,
            [key]: (state.useCounts[key] ?? 0) + 1,
          },
        }));
      },
    }),
    { name: "omnipanel.quickLauncher.actionStats" },
  ),
);
