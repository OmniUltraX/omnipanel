import { create } from "zustand";

/** 当前在状态栏 ActionBar 中展示配置的 dock 面板上下文 */
export type StatusBarActiveDock = {
  dockScope: string;
  panelId: string;
  panelType: string;
  panelLabel?: string;
};

interface StatusBarActionBarState {
  activeDock: StatusBarActiveDock | null;
  setActiveDock: (dock: StatusBarActiveDock | null) => void;
  clearActiveDockIfScope: (dockScope: string) => void;
}

export const useStatusBarActionBarStore = create<StatusBarActionBarState>((set, get) => ({
  activeDock: null,
  setActiveDock: (activeDock) => set({ activeDock }),
  clearActiveDockIfScope: (dockScope) => {
    if (get().activeDock?.dockScope === dockScope) {
      set({ activeDock: null });
    }
  },
}));

export function publishStatusBarActiveDock(
  dockScope: string | undefined,
  panelId: string | null,
  meta: { panelType?: string; label?: string } | undefined,
  enabled: boolean,
): void {
  if (!enabled || !dockScope || !panelId) {
    if (dockScope) {
      useStatusBarActionBarStore.getState().clearActiveDockIfScope(dockScope);
    }
    return;
  }
  useStatusBarActionBarStore.getState().setActiveDock({
    dockScope,
    panelId,
    panelType: meta?.panelType ?? "unknown",
    panelLabel: meta?.label,
  });
}
