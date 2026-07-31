import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriRuntime } from "./isTauriRuntime";

export const QUICK_LAUNCHER_LABEL = "quick-launcher";

export type QuickLauncherAction =
  | { kind: "command"; id: string }
  /** @deprecated 兼容旧 payload；新逻辑请用 ssh-connection / db-* */
  | { kind: "connection"; id: string }
  | { kind: "ssh-connection"; connectionId: string }
  | { kind: "db-connection"; connectionId: string }
  | { kind: "db-database"; connectionId: string; database: string }
  | { kind: "db-table"; connectionId: string; database: string; table: string }
  | { kind: "run-terminal"; command: string; execute: boolean; resourceId?: string }
  | {
      kind: "run-sql";
      connectionId: string;
      database?: string;
      sql: string;
      mode: "execute" | "draft";
    }
  | { kind: "ask-ai"; prompt: string }
  | { kind: "save-note"; title: string; content: string }
  | { kind: "create-todo"; title: string }
  | { kind: "open-url"; url: string; target: "http" | "browser" }
  | { kind: "open-path"; path: string };

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

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isQuickLauncherAction(payload: unknown): payload is QuickLauncherAction {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  switch (p.kind) {
    case "command":
    case "connection":
      return isNonEmptyString(p.id);
    case "ssh-connection":
    case "db-connection":
      return isNonEmptyString(p.connectionId);
    case "db-database":
      return isNonEmptyString(p.connectionId) && isNonEmptyString(p.database);
    case "db-table":
      return (
        isNonEmptyString(p.connectionId) &&
        isNonEmptyString(p.database) &&
        isNonEmptyString(p.table)
      );
    case "run-terminal":
      return isNonEmptyString(p.command) && typeof p.execute === "boolean";
    case "run-sql":
      return (
        isNonEmptyString(p.connectionId) &&
        isNonEmptyString(p.sql) &&
        (p.mode === "execute" || p.mode === "draft")
      );
    case "ask-ai":
      return isNonEmptyString(p.prompt);
    case "save-note":
      return isNonEmptyString(p.title) && typeof p.content === "string";
    case "create-todo":
      return isNonEmptyString(p.title);
    case "open-url":
      return (
        isNonEmptyString(p.url) && (p.target === "http" || p.target === "browser")
      );
    case "open-path":
      return isNonEmptyString(p.path);
    default:
      return false;
  }
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
    if (!isQuickLauncherAction(event.payload)) return;
    handler(event.payload);
  });
}

export type QuickLauncherShownPayload = {
  /** Ctrl+Space 唤醒时为 true，可直接显示热键角标 */
  ctrlHeld?: boolean;
};

export async function listenQuickLauncherShown(
  handler: (payload: QuickLauncherShownPayload) => void,
): Promise<UnlistenFn> {
  return listen<QuickLauncherShownPayload | null>(
    "omnipanel:quick-launcher-shown",
    (event) => {
      const payload = event.payload;
      handler(
        payload && typeof payload === "object"
          ? { ctrlHeld: payload.ctrlHeld === true }
          : {},
      );
    },
  );
}
