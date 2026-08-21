import { create } from "zustand";

import type { PanelProbeResult } from "@/ipc/bindings";

type PanelProbeState = {
  /** resourceId → 最近一次面板探测结果 */
  results: Record<string, PanelProbeResult>;
  setResult: (resourceId: string, result: PanelProbeResult) => void;
  clear: () => void;
};

/**
 * SSH 面板探测缓存（宝塔 / 1Panel）。
 * 详情页探测后写入，侧栏主机行据此展示图标。
 */
export const usePanelProbeStore = create<PanelProbeState>((set) => ({
  results: {},
  setResult: (resourceId, result) =>
    set((state) => ({
      results: { ...state.results, [resourceId]: result },
    })),
  clear: () => set({ results: {} }),
}));
