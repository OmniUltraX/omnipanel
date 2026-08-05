import {
  requestAppChoose,
  type AppDialogAction,
  type AppDialogActionVariant,
} from "../stores/appDialogStore";

export type { AppDialogAction, AppDialogActionVariant };

/**
 * 应用内多选对话框（全局 `AppDialogHost` + `WarnAlert` 渲染）。
 *
 * 用于"自动改名 / 覆盖 / 跳过"等三选一场景，避免两层 confirm 叠弹窗。
 * - 用户选中某个 action → resolve 该 action 的 id
 * - 用户关闭/按 Esc / 被新请求顶替 → resolve null
 *
 * **禁止**改为 Tauri / `window.confirm` 原生弹窗。
 */
export function appChoose(
  message: string,
  title: string,
  actions: AppDialogAction[],
): Promise<string | null> {
  return requestAppChoose(message, title, actions);
}
