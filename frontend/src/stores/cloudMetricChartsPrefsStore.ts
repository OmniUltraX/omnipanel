import { create } from "zustand";
import { persist } from "zustand/middleware";

type State = {
  /**
   * 按「插件 + 能力」记住要显示的监控指标 id。
   * 缺省 key = 显示全部当前可用指标。
   */
  byScope: Record<string, string[]>;
  setVisibleIds: (scope: string, ids: string[]) => void;
  clearScope: (scope: string) => void;
};

export function cloudMetricChartsScope(pluginId: string, capability: string): string {
  return `${pluginId.trim() || "cloud"}::${capability.trim() || "default"}`;
}

/** 将持久化选择与当前可用指标求交；从未配置过则默认全选。 */
export function resolveVisibleMetricIds(
  availableIds: readonly string[],
  saved: string[] | undefined,
): string[] {
  if (availableIds.length === 0) return [];
  if (saved == null) return [...availableIds];
  const allow = new Set(saved);
  const picked = availableIds.filter((id) => allow.has(id));
  // 旧偏好与当前指标完全无交集（厂商改名等）时回退全选，避免空白页
  return picked.length > 0 ? picked : [...availableIds];
}

export const useCloudMetricChartsPrefsStore = create<State>()(
  persist(
    (set) => ({
      byScope: {},
      setVisibleIds: (scope, ids) => {
        const key = scope.trim();
        if (!key) return;
        const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
        set((state) => ({
          byScope: { ...state.byScope, [key]: unique },
        }));
      },
      clearScope: (scope) => {
        const key = scope.trim();
        if (!key) return;
        set((state) => {
          if (!(key in state.byScope)) return state;
          const next = { ...state.byScope };
          delete next[key];
          return { byScope: next };
        });
      },
    }),
    {
      name: "omnipanel.cloud.metric-charts-visible",
      partialize: (state) => ({ byScope: state.byScope }),
    },
  ),
);
