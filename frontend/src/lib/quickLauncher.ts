import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriRuntime } from "./isTauriRuntime";

export const QUICK_LAUNCHER_LABEL = "quick-launcher";

export type QuickLauncherAction =
  | { kind: "command"; id: string }
  | { kind: "connection"; id: string };

declare global {
  interface Window {
    __OMNIPANEL_QUICK_LAUNCHER__?: boolean;
  }
}

/** 当前 WebView 是否为快捷启动窗。 */
export function isQuickLauncherWindow(): boolean {
  if (typeof window === "undefined") return false;
  if (window.__OMNIPANEL_QUICK_LAUNCHER__ === true) return true;
  try {
    if (isTauriRuntime() && getCurrentWindow().label === QUICK_LAUNCHER_LABEL) {
      return true;
    }
  } catch {
    /* ignore */
  }
  const params = new URLSearchParams(window.location.search);
  return params.get("win") === "quick-launcher";
}

export async function syncTrayActiveToBackend(active: boolean): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await invoke("set_app_tray_active", { active });
  } catch (e) {
    console.warn("[quickLauncher] set_app_tray_active failed", e);
  }
}

export async function showQuickLauncher(): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("show_quick_launcher");
}

export async function hideQuickLauncher(): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("hide_quick_launcher");
}

export async function toggleQuickLauncher(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  return invoke<boolean>("toggle_quick_launcher");
}

export async function setQuickLauncherHeight(height: number): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("set_quick_launcher_height", { height });
}

export async function emitQuickLauncherAction(action: QuickLauncherAction): Promise<void> {
  if (!isTauriRuntime()) return;
  const { emit } = await import("@tauri-apps/api/event");
  await emit("omnipanel:quick-launcher-action", action);
}

export async function listenQuickLauncherAction(
  handler: (action: QuickLauncherAction) => void,
): Promise<UnlistenFn> {
  return listen<QuickLauncherAction>("omnipanel:quick-launcher-action", (event) => {
    if (!event.payload?.kind || !event.payload.id) return;
    handler(event.payload);
  });
}

export async function listenQuickLauncherShown(handler: () => void): Promise<UnlistenFn> {
  return listen("omnipanel:quick-launcher-shown", () => handler());
}
