import { create } from "zustand";
import type { ModuleKey } from "../lib/paths";

export type StatusBarLogLevel = "info" | "progress" | "success" | "error";

export interface StatusBarLogEntry {
  id: number;
  message: string;
  level: StatusBarLogLevel;
  timestamp: number;
}

interface StatusBarLogState {
  /** 当前激活模块，仅有权向其发布日志 */
  activePublisher: ModuleKey | null;
  logsByModule: Partial<Record<ModuleKey, StatusBarLogEntry>>;
  setActivePublisher: (module: ModuleKey | null) => void;
  publish: (module: ModuleKey, message: string, level?: StatusBarLogLevel) => void;
  clear: (module: ModuleKey) => void;
}

let nextLogId = 1;

export const useStatusBarLogStore = create<StatusBarLogState>((set) => ({
  activePublisher: null,
  logsByModule: {},

  setActivePublisher: (module) => set({ activePublisher: module }),

  publish: (module, message, level = "info") => {
    const entry: StatusBarLogEntry = {
      id: nextLogId++,
      message,
      level,
      timestamp: Date.now(),
    };
    set((state) => ({
      logsByModule: { ...state.logsByModule, [module]: entry },
    }));
  },

  clear: (module) =>
    set((state) => {
      const next = { ...state.logsByModule };
      delete next[module];
      return { logsByModule: next };
    }),
}));
