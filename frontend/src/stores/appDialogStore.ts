/**
 * 全局 confirm / alert / choose 队列（Zustand）。
 *
 * ## 对话框策略（勿删、勿改回原生）
 * - 业务代码只调用 `appConfirm` / `appAlert` / `appChoose`（见 `lib/`）
 * - 渲染链路：本 store → `AppDialogHost` → `WarnAlert`
 * - **禁止** Tauri `plugin-dialog` 的 confirm/message/ask，也禁止 `window.confirm/alert`
 * - 文件选择/保存可继续使用 `plugin-dialog` 的 `open` / `save`
 *
 * 历史：`4d17e81` 曾误删本体系并改回系统弹窗，已在后续恢复。
 */
import { create } from "zustand";

export type AppDialogKind = "confirm" | "alert";

export type AppDialogActionVariant = "primary" | "warn" | "secondary" | "danger" | "ghost";

export interface AppDialogAction {
  /** 选中后通过 `appChoose` 返回的 id */
  id: string;
  label: string;
  variant?: AppDialogActionVariant;
}

export interface AppDialogOptions {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 多按钮选项；非空时替代 confirm/cancel，调用方应走 `appChoose` */
  actions?: AppDialogAction[];
}

interface AppDialogRequest extends AppDialogOptions {
  kind: AppDialogKind;
  resolve: (value: boolean | string | null) => void;
}

interface AppDialogState {
  request: AppDialogRequest | null;
  open: (options: AppDialogOptions & { kind: AppDialogKind }) => Promise<boolean | string | null>;
  confirm: () => void;
  cancel: () => void;
  choose: (actionId: string) => void;
}

export const useAppDialogStore = create<AppDialogState>((set, get) => ({
  request: null,
  open: (options) =>
    new Promise((resolve) => {
      const prev = get().request;
      if (prev) {
        // 旧请求被新请求顶替：按"取消"语义 resolve（confirm→false / choose→null）
        prev.resolve(prev.actions && prev.actions.length > 0 ? null : false);
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
    if (!req) {
      return;
    }
    req.resolve(true);
    set({ request: null });
  },
  cancel: () => {
    const req = get().request;
    if (!req) {
      return;
    }
    req.resolve(req.actions && req.actions.length > 0 ? null : false);
    set({ request: null });
  },
  choose: (actionId) => {
    const req = get().request;
    if (!req) {
      return;
    }
    req.resolve(actionId);
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
  }) as Promise<boolean>;
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

/**
 * 应用内多选对话框：返回选中的 action id；用户关闭/取消时返回 null。
 * 用于"自动改名 / 覆盖 / 跳过"这类三选一场景，避免两层 confirm。
 */
export function requestAppChoose(
  message: string,
  title: string,
  actions: AppDialogAction[],
): Promise<string | null> {
  return useAppDialogStore
    .getState()
    .open({
      kind: "confirm",
      message,
      title,
      actions,
    })
    .then((v) => (typeof v === "string" ? v : null));
}
