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

function forgetModuleWindowWarm(moduleKey: string): void {
  if (!isModuleWindowSupported(moduleKey)) return;
  ensureDone.delete(moduleKey);
  ensureInflight.delete(moduleKey);
}

/** 模块窗被后端空闲卸载后，清除前端「已预热」标记，下次打开走冷启动。 */
let destroyedListenerStarted = false;
function ensureDestroyedListener(): void {
  if (destroyedListenerStarted || !isTauriRuntime()) return;
  destroyedListenerStarted = true;
  void listen<ModuleWindowLifecyclePayload>(
    "omnipanel:module-window-destroyed",
    (event) => {
      const key = event.payload?.moduleKey?.trim();
      if (!key) return;
      forgetModuleWindowWarm(key);
    },
  ).catch((e) => {
    console.warn("[moduleWindow] listen destroyed failed", e);
    destroyedListenerStarted = false;
  });
}

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
  ensureDestroyedListener();
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
  ensureDestroyedListener();
  try {
    await ensureModuleWindowHidden(moduleKey);
    await invoke<string>("open_module_window", { moduleKey, title });
    ensureDone.add(moduleKey);
  } catch (e) {
    // 可能已被空闲卸载，清标记后重试一次冷启动
    forgetModuleWindowWarm(moduleKey);
    try {
      await ensureModuleWindowHidden(moduleKey);
      await invoke<string>("open_module_window", { moduleKey, title });
      ensureDone.add(moduleKey);
    } catch (retryErr) {
      const message = retryErr instanceof Error ? retryErr.message : String(retryErr);
      showToast(`打开独立窗口失败: ${message}`);
      throw retryErr;
    }
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
