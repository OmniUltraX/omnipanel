import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriRuntime } from "./isTauriRuntime";
import { ALL_MODULE_KEYS, MODULE_PATHS, type ModuleKey } from "./paths";
import { showToast } from "../stores/toastStore";

export const MODULE_WINDOW_PREFIX = "module-";

declare global {
  interface Window {
    __OMNIPANEL_MODULE_WINDOW__?: string;
  }
}

export type ModuleWindowParams = {
  moduleKey: ModuleKey;
};

export type ModuleWindowLifecyclePayload = {
  moduleKey: string;
  label: string;
};

/** 侧栏各业务模块均可独立开窗（与 MODULE_PATHS 对齐） */
export const SUPPORTED_MODULE_KEYS: readonly ModuleKey[] = ALL_MODULE_KEYS;

const SUPPORTED_MODULE_KEY_SET = new Set<ModuleKey>(SUPPORTED_MODULE_KEYS);
const ensureInflight = new Set<ModuleKey>();
const ensureDone = new Set<ModuleKey>();

export function isModuleWindowSupported(moduleKey: string): moduleKey is ModuleKey {
  return SUPPORTED_MODULE_KEY_SET.has(moduleKey as ModuleKey);
}

export function moduleWindowLabel(moduleKey: string): string {
  return `${MODULE_WINDOW_PREFIX}${moduleKey}`;
}

/** 解析当前 WebView 是否为模块独立窗。 */
export function parseModuleWindowParams(): ModuleWindowParams | null {
  if (typeof window === "undefined") return null;

  const injected = window.__OMNIPANEL_MODULE_WINDOW__;
  if (typeof injected === "string" && injected.trim()) {
    const key = injected.trim() as ModuleKey;
    if (key in MODULE_PATHS) return { moduleKey: key };
  }

  try {
    if (isTauriRuntime()) {
      const label = getCurrentWindow().label;
      if (label.startsWith(MODULE_WINDOW_PREFIX)) {
        const key = label.slice(MODULE_WINDOW_PREFIX.length) as ModuleKey;
        if (key in MODULE_PATHS) return { moduleKey: key };
      }
    }
  } catch {
    /* ignore */
  }

  const params = new URLSearchParams(window.location.search);
  if (params.get("win") === "module") {
    const key = (params.get("module") ?? "").trim() as ModuleKey;
    if (key in MODULE_PATHS) return { moduleKey: key };
  }

  return null;
}

/** 按需创建模块窗并保持隐藏（已存在则立即返回）。 */
async function ensureModuleWindowHidden(moduleKey: ModuleKey): Promise<void> {
  if (!isTauriRuntime() || !isModuleWindowSupported(moduleKey)) return;
  if (ensureDone.has(moduleKey) || ensureInflight.has(moduleKey)) return;
  ensureInflight.add(moduleKey);
  try {
    await invoke<string>("ensure_module_window_prewarm", { moduleKey });
    ensureDone.add(moduleKey);
  } catch (e) {
    console.warn("[moduleWindow] ensure hidden failed", moduleKey, e);
  } finally {
    ensureInflight.delete(moduleKey);
  }
}

/** 打开（或聚焦）模块独立窗口。首次打开时按需创建隐藏 WebView。 */
export async function openModuleWindow(moduleKey: ModuleKey, title: string): Promise<void> {
  if (!isTauriRuntime()) {
    showToast("非 Tauri 运行时，无法创建独立窗口");
    return;
  }
  if (!isModuleWindowSupported(moduleKey)) {
    showToast(`模块「${moduleKey}」暂不支持独立窗口`);
    return;
  }
  try {
    await ensureModuleWindowHidden(moduleKey);
    await invoke<string>("open_module_window", { moduleKey, title });
    ensureDone.add(moduleKey);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    showToast(`打开独立窗口失败: ${message}`);
    throw e;
  }
}

export async function listenModuleWindowShown(
  handler: (payload: ModuleWindowLifecyclePayload) => void,
): Promise<UnlistenFn> {
  return listen<ModuleWindowLifecyclePayload>("omnipanel:module-window-shown", (event) => {
    if (!event.payload?.moduleKey) return;
    handler(event.payload);
  });
}
