import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriRuntime } from "./isTauriRuntime";
import { ALL_MODULE_KEYS, MODULE_PATHS, moduleKeyFromPath, type ModuleKey } from "./paths";
import { showToast } from "../stores/toastStore";
import { getNavVisibleModuleKeys } from "../stores/appModuleStore";

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

/** 与 Rust `PREWARM_MODULE_KEYS` 顺序对齐（错峰预热） */
export const MODULE_WINDOW_PREWARM_ORDER: readonly ModuleKey[] = [
  "database",
  "terminal",
  "docker",
  "server",
  "files",
  "protocol",
  "workflow",
  "knowledge",
  "tasks",
  "ssh",
];

const SUPPORTED_MODULE_KEY_SET = new Set<ModuleKey>(SUPPORTED_MODULE_KEYS);
const prewarmInflight = new Set<ModuleKey>();
const prewarmDone = new Set<ModuleKey>();

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

/** 预创建模块窗并保持隐藏（热复用）；已存在则立即返回。 */
export async function ensureModuleWindowPrewarm(moduleKey: ModuleKey): Promise<void> {
  if (!isTauriRuntime() || !isModuleWindowSupported(moduleKey)) return;
  if (prewarmDone.has(moduleKey) || prewarmInflight.has(moduleKey)) return;
  prewarmInflight.add(moduleKey);
  try {
    await invoke<string>("ensure_module_window_prewarm", { moduleKey });
    prewarmDone.add(moduleKey);
  } catch (e) {
    console.warn("[moduleWindow] prewarm failed", moduleKey, e);
  } finally {
    prewarmInflight.delete(moduleKey);
  }
}

/** 侧栏悬停：顺带预建独立窗（不显示）。 */
export function scheduleModuleWindowHoverPrewarm(path: string): () => void {
  const moduleKey = moduleKeyFromPath(path);
  if (!moduleKey || !isModuleWindowSupported(moduleKey) || !isTauriRuntime()) {
    return () => {};
  }
  const timer = window.setTimeout(() => {
    void ensureModuleWindowPrewarm(moduleKey);
  }, 160);
  return () => {
    window.clearTimeout(timer);
  };
}

/**
 * 主窗就绪后错峰补预热可见模块（与 Rust 后台预热互补；已存在的窗会被跳过）。
 */
export function scheduleIdleModuleWindowPrewarm(options?: {
  initialDelayMs?: number;
  stepMs?: number;
}): () => void {
  if (!isTauriRuntime()) return () => {};

  const initialDelayMs = options?.initialDelayMs ?? 2200;
  const stepMs = options?.stepMs ?? 800;
  let cancelled = false;
  let stepTimer: number | null = null;

  const startTimer = window.setTimeout(() => {
    const visible = new Set(getNavVisibleModuleKeys());
    const keys = MODULE_WINDOW_PREWARM_ORDER.filter(
      (key) => isModuleWindowSupported(key) && visible.has(key),
    );
    let index = 0;

    const next = () => {
      if (cancelled) return;
      if (index >= keys.length) return;
      const key = keys[index++];
      void ensureModuleWindowPrewarm(key).finally(() => {
        if (cancelled) return;
        stepTimer = window.setTimeout(next, stepMs);
      });
    };
    next();
  }, initialDelayMs);

  return () => {
    cancelled = true;
    window.clearTimeout(startTimer);
    if (stepTimer != null) window.clearTimeout(stepTimer);
  };
}

/** 打开（或聚焦）模块独立窗口。 */
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
    // 打开前尽量保证已预热；已存在则几乎无开销
    await ensureModuleWindowPrewarm(moduleKey);
    await invoke<string>("open_module_window", { moduleKey, title });
    prewarmDone.add(moduleKey);
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
