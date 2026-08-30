import { create } from "zustand";
import { persist } from "zustand/middleware";

type PluginStat = {
  installs: number;
};

type PluginMarketStatsState = {
  byId: Record<string, PluginStat>;
  installsOf: (id: string) => number;
  recordInstall: (id: string) => void;
};

function emptyStat(): PluginStat {
  return { installs: 0 };
}

export const usePluginMarketStatsStore = create<PluginMarketStatsState>()(
  persist(
    (set, get) => ({
      byId: {},
      installsOf: (id) => get().byId[id]?.installs ?? 0,
      recordInstall: (id) => {
        const key = id.trim();
        if (!key) return;
        const prev = get().byId[key] ?? emptyStat();
        set((state) => ({
          byId: {
            ...state.byId,
            [key]: {
              installs: prev.installs + 1,
            },
          },
        }));
      },
    }),
    {
      name: "omnipanel.pluginCenter.marketStats",
      partialize: (state) => ({ byId: state.byId }),
    },
  ),
);
