import { create } from "zustand";

export interface QuickInputOptions {
  title: string;
  subtitle?: string;
  placeholder?: string;
  defaultValue?: string;
  /** 密码输入模式 */
  password?: boolean;
  validate?: (value: string) => string | null;
}

interface QuickInputRequest extends QuickInputOptions {
  resolve: (value: string | null) => void;
}

interface QuickInputState {
  request: QuickInputRequest | null;
  open: (options: QuickInputOptions) => Promise<string | null>;
  confirm: (value: string) => void;
  cancel: () => void;
}

export const useQuickInputStore = create<QuickInputState>((set, get) => ({
  request: null,
  open: (options) =>
    new Promise((resolve) => {
      const prev = get().request;
      if (prev) {
        prev.resolve(null);
      }
      set({
        request: {
          ...options,
          resolve,
        },
      });
    }),
  confirm: (value) => {
    const req = get().request;
    if (!req) {
      return;
    }
    req.resolve(value);
    set({ request: null });
  },
  cancel: () => {
    const req = get().request;
    if (!req) {
      return;
    }
    req.resolve(null);
    set({ request: null });
  },
}));

/** 阻塞式快速输入，Enter 确认，Esc / 取消关闭；取消时返回 null */
export function quickInput(options: QuickInputOptions): Promise<string | null> {
  return useQuickInputStore.getState().open(options);
}
