import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { SerializedDockview } from "dockview-core";
import {
  removePanelFromLayout,
  collectPanelIds,
  isLayoutUsable,
} from "../components/dock/dockViewLayout";

/**
 * v5：在 dockViewLayout 中新增 isLayoutUsable 校验 + layoutNeedsMerge 检测
 *     views 漂移。v4 之前写入的脏数据（panels↔views 不一致 / 缺少 group id）
 *     通过 migrate 主动丢弃，避免加载时触发 dockview fromJSON 抛错。
 * v4：fix dockViewLayout 中 stripMissingPanels/addMissingPanels 的 panels↔views 一致性 bug
 * v3：切换到 dockview 序列化（SerializedDockview），与旧版 rc-dock 布局不兼容。
 */
const STORAGE_KEY = "omnipanel.terminalDockLayout.v5";
const STORAGE_VERSION = 5;

interface TerminalDockLayoutState {
  savedLayout: SerializedDockview | null;
  setSavedLayout: (layout: SerializedDockview | null) => void;
  reset: () => void;
}

export const useTerminalDockLayoutStore = create<TerminalDockLayoutState>()(
  persist(
    (set) => ({
      savedLayout: null,
      setSavedLayout: (savedLayout) => set({ savedLayout }),
      reset: () => set({ savedLayout: null }),
    }),
    {
      name: STORAGE_KEY,
      version: STORAGE_VERSION,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ savedLayout: state.savedLayout }),
      migrate: (persistedState, _fromVersion) => {
        // 任何旧版本升级都强制校验现有 savedLayout；不合法则丢弃。
        const p = persistedState as { savedLayout?: SerializedDockview | null } | undefined;
        if (p && !isLayoutUsable(p.savedLayout ?? null)) {
          return { savedLayout: null } as { savedLayout: SerializedDockview | null };
        }
        return p as { savedLayout: SerializedDockview | null };
      },
    },
  ),
);

export function removeTabFromLayout(
  savedLayout: SerializedDockview | null,
  tabId: string,
): SerializedDockview | null {
  const next = removePanelFromLayout(savedLayout, tabId);
  if (next && collectPanelIds(next).size === 0) return null;
  return next;
}
