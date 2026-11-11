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
const autoClearTimers = new Map<string, number>();
const SUCCESS_AUTO_CLEAR_MS = 4000;
const ERROR_AUTO_CLEAR_MS = 8000;

function clearAutoClearTimer(module: string): void {
  const timer = autoClearTimers.get(module);
  if (timer != null) {
    window.clearTimeout(timer);
    autoClearTimers.delete(module);
  }
}

export const useStatusBarLogStore = create<StatusBarLogState>((set, get) => ({
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
    clearAutoClearTimer(module);
    set((state) => ({
      logsByModule: { ...state.logsByModule, [module]: entry },
    }));
    const autoClearMs =
      level === "success" ? SUCCESS_AUTO_CLEAR_MS : level === "error" ? ERROR_AUTO_CLEAR_MS : 0;
    if (autoClearMs > 0) {
      const id = entry.id;
      const timer = window.setTimeout(() => {
        autoClearTimers.delete(module);
        const current = get().logsByModule[module];
        if (current?.id === id) {
          get().clear(module);
        }
      }, autoClearMs);
      autoClearTimers.set(module, timer);
    }
  },

  clear: (module) => {
    clearAutoClearTimer(module);
    set((state) => {
      const next = { ...state.logsByModule };
      delete next[module];
      return { logsByModule: next };
    });
  },
}));
