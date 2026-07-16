import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, type CloseRequestedEvent } from "@tauri-apps/api/window";
import { requestCloseBehaviorDialog } from "../stores/closeBehaviorDialogStore";
import {
  normalizeCloseBehavior,
  useSettingsStore,
  type CloseBehavior,
} from "../stores/settingsStore";
import { isTauriRuntime } from "./isTauriRuntime";
import { markWindowHiddenToTray } from "./trayHiddenWindows";

export type WindowCloseRole = "main" | "workspace";

async function quitApplication(): Promise<void> {
  try {
    await invoke("close_all_workspace_windows");
  } catch {
    /* ignore */
  }
  try {
    await invoke("app_exit");
  } catch (e) {
    console.error("[windowCloseBehavior] app_exit failed", e);
  }
}

async function hideCurrentWindowToTray(): Promise<void> {
  const win = getCurrentWindow();
  markWindowHiddenToTray(win.label);
  await win.hide();
}

/**
 * 根据设置解析关闭动作；`ask` 时弹窗。返回 `null` 表示取消关闭。
 */
export async function resolveCloseAction(): Promise<"tray" | "quit" | null> {
  const behavior = normalizeCloseBehavior(useSettingsStore.getState().closeBehavior);
  if (behavior === "tray") return "tray";
  if (behavior === "quit") return "quit";

  const result = await requestCloseBehaviorDialog();
  if (!result) return null;
  if (result.remember) {
    const next: CloseBehavior = result.choice;
    useSettingsStore.getState().setCloseBehavior(next);
  }
  return result.choice;
}

/**
 * 处理当前窗口的 CloseRequested。
 * 调用方应先 `event.preventDefault()`，本函数负责托盘隐藏或退出应用。
 * 返回 `true` 表示已处理（隐藏/退出）；`false` 表示用户取消。
 */
export async function handleWindowCloseRequested(
  event: CloseRequestedEvent,
  _role: WindowCloseRole,
): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  event.preventDefault();

  const action = await resolveCloseAction();
  if (!action) return false;

  if (action === "tray") {
    await hideCurrentWindowToTray();
    return true;
  }

  await quitApplication();
  return true;
}
