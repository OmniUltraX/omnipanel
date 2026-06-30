import { create } from "zustand";

export type AppDialogKind = "confirm" | "alert";

export interface AppDialogOptions {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

interface AppDialogRequest extends AppDialogOptions {
  kind: AppDialogKind;
  resolve: (value: boolean) => void;
}

interface AppDialogState {
  request: AppDialogRequest | null;
  open: (options: AppDialogOptions & { kind: AppDialogKind }) => Promise<boolean>;
  confirm: () => void;
  cancel: () => void;
}

export const useAppDialogStore = create<AppDialogState>((set, get) => ({
  request: null,
  open: (options) =>
    new Promise((resolve) => {
      const prev = get().request;
      if (prev) {
        prev.resolve(false);
      }
      set({
        request: {
          ...options,
          title: options.title ?? "OmniPanel",
          resolve,
        },
      });
    }),
  confirm: () => {
    const req = get().request;
    if (!req) return;
    req.resolve(true);
    set({ request: null });
  },
  cancel: () => {
    const req = get().request;
    if (!req) return;
    req.resolve(false);
    set({ request: null });
  },
}));

/** 应用内确认框，替代 window.confirm / Tauri 原生 dialog */
export function requestAppConfirm(
  message: string,
  title = "OmniPanel",
  options?: Omit<AppDialogOptions, "message" | "title">,
): Promise<boolean> {
  return useAppDialogStore.getState().open({
    kind: "confirm",
    message,
    title,
    ...options,
  });
}

/** 应用内提示框，替代 window.alert */
export async function requestAppAlert(
  message: string,
  title = "OmniPanel",
  options?: Omit<AppDialogOptions, "message" | "title">,
): Promise<void> {
  await useAppDialogStore.getState().open({
    kind: "alert",
    message,
    title,
    ...options,
  });
}
