/**
 * 窗口关闭行为对话框（托盘 / 退出 + 记住选择）。
 * 渲染：`CloseBehaviorDialogHost` → 勿改回原生 dialog。
 */
import { create } from "zustand";

export type CloseBehaviorChoice = "tray" | "quit";

export interface CloseBehaviorDialogResult {
  choice: CloseBehaviorChoice;
  remember: boolean;
}

interface CloseBehaviorDialogRequest {
  resolve: (value: CloseBehaviorDialogResult | null) => void;
}

interface CloseBehaviorDialogState {
  request: CloseBehaviorDialogRequest | null;
  open: () => Promise<CloseBehaviorDialogResult | null>;
  choose: (choice: CloseBehaviorChoice, remember: boolean) => void;
  cancel: () => void;
}

export const useCloseBehaviorDialogStore = create<CloseBehaviorDialogState>((set, get) => ({
  request: null,
  open: () =>
    new Promise((resolve) => {
      const prev = get().request;
      if (prev) prev.resolve(null);
      set({ request: { resolve } });
    }),
  choose: (choice, remember) => {
    const req = get().request;
    if (!req) return;
    req.resolve({ choice, remember });
    set({ request: null });
  },
  cancel: () => {
    const req = get().request;
    if (!req) return;
    req.resolve(null);
    set({ request: null });
  },
}));

export function requestCloseBehaviorDialog(): Promise<CloseBehaviorDialogResult | null> {
  return useCloseBehaviorDialogStore.getState().open();
}
