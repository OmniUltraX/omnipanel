import { create } from "zustand";
import type { PluginEnsurePendingItem } from "../ipc/bindings";

interface PluginEnsureState {
  pending: PluginEnsurePendingItem[];
  confirming: boolean;
  running: boolean;
  setPending: (items: PluginEnsurePendingItem[]) => void;
  setConfirming: (value: boolean) => void;
  setRunning: (value: boolean) => void;
  clearPending: () => void;
}

/** 同步缺件第三方确认队列。禁止 import modules。 */
export const usePluginEnsureStore = create<PluginEnsureState>((set) => ({
  pending: [],
  confirming: false,
  running: false,
  setPending: (pending) => set({ pending, confirming: false }),
  setConfirming: (confirming) => set({ confirming }),
  setRunning: (running) => set({ running }),
  clearPending: () => set({ pending: [], confirming: false }),
}));
