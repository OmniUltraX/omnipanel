import type { OverlayModuleKey } from "./routePanels";
import { isOverlayModuleKey, OVERLAY_MODULE_KEYS } from "./routePanels";
import { moduleKeyFromPath, MODULE_PATHS } from "./paths";

type ModuleChunkLoader = () => Promise<unknown>;

const OVERLAY_CHUNK_LOADERS: Record<OverlayModuleKey, ModuleChunkLoader> = {
  terminal: () => import("../modules/terminal/TerminalPanel"),
  database: () => import("../modules/database/DatabasePanel"),
  docker: () => import("../modules/docker/DockerPanel"),
  files: () => import("../modules/files/FilesPanel"),
  server: () => import("../modules/server/ServerPanel"),
  protocol: () => import("../modules/protocol/ProtocolPanel"),
  workflow: () => import("../modules/workflow/WorkflowPanel"),
  knowledge: () => import("../modules/knowledge/KnowledgePanel"),
  tasks: () => import("../modules/tasks/TaskCenterPanel"),
};

/** 空闲 Shell 预热顺序：终端优先，与 chunk 预热一致 */
export const IDLE_OVERLAY_SHELL_KEYS: readonly OverlayModuleKey[] = [
  "terminal",
  "database",
  "docker",
  "server",
  "files",
  "protocol",
  "workflow",
  "knowledge",
  "tasks",
];

const chunkInflight = new Map<OverlayModuleKey, Promise<void>>();
const chunkReady = new Set<OverlayModuleKey>();
/** 已请求过挂壳的模块（去重；App 侧仍会再判 overlayMounted） */
const shellWarmRequested = new Set<OverlayModuleKey>();

type ShellWarmListener = (key: OverlayModuleKey) => void;
const shellWarmListeners = new Set<ShellWarmListener>();

function scheduleIdleOrTimeout(run: () => void, timeoutMs: number): () => void {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(run, { timeout: timeoutMs });
    return () => {
      if (typeof cancelIdleCallback === "function") cancelIdleCallback(id);
    };
  }
  const timer = window.setTimeout(run, Math.min(timeoutMs, 3000));
  return () => window.clearTimeout(timer);
}

/** 订阅「预挂载模块壳」请求（不激活路由，仅让 Overlay 提前 mount） */
export function subscribeModuleShellWarm(listener: ShellWarmListener): () => void {
  shellWarmListeners.add(listener);
  return () => {
    shellWarmListeners.delete(listener);
  };
}

/** 请求预挂载模块壳；调用方应在 startTransition 中更新 mounted 状态 */
export function requestModuleShellWarm(key: OverlayModuleKey): void {
  shellWarmRequested.add(key);
  for (const listener of shellWarmListeners) {
    listener(key);
  }
}

/** 预拉取单个叠层模块的 JS chunk（不挂载 React 树） */
export function preloadOverlayModuleChunk(key: OverlayModuleKey): Promise<void> {
  if (chunkReady.has(key)) return Promise.resolve();
  const existing = chunkInflight.get(key);
  if (existing) return existing;

  const loader = OVERLAY_CHUNK_LOADERS[key];
  const promise = loader()
    .then(() => {
      chunkReady.add(key);
    })
    .catch(() => {
      /* 预热失败不影响功能路径 */
    })
    .finally(() => {
      chunkInflight.delete(key);
    });
  chunkInflight.set(key, promise);
  return promise;
}

export function isOverlayModuleChunkReady(key: OverlayModuleKey): boolean {
  return chunkReady.has(key);
}

export function isOverlayModuleShellWarmRequested(key: OverlayModuleKey): boolean {
  return shellWarmRequested.has(key);
}

/** 侧栏路径 → 叠层模块 key；非叠层返回 null */
export function overlayKeyFromNavPath(path: string): OverlayModuleKey | null {
  const key = moduleKeyFromPath(path);
  return isOverlayModuleKey(key) ? key : null;
}

/**
 * 悬停意图：先拉 chunk，停留超过 hoverMs 再请求挂载壳。
 * 返回取消函数（mouseleave 时调用）。
 */
export function scheduleNavHoverWarm(
  path: string,
  hoverMs = 140,
): () => void {
  const key = overlayKeyFromNavPath(path);
  if (!key) return () => {};

  void preloadOverlayModuleChunk(key);
  const timer = window.setTimeout(() => {
    requestModuleShellWarm(key);
  }, hoverMs);

  return () => {
    window.clearTimeout(timer);
  };
}

export interface IdleOverlayShellWarmOptions {
  keys?: readonly OverlayModuleKey[];
  /** 首个模块开始 shell 预热的 idle timeout（ms） */
  initialShellTimeoutMs?: number;
  /** 后续每个模块之间的 idle timeout（ms） */
  stepShellTimeoutMs?: number;
}

/**
 * 空闲错峰：逐个 preload chunk → requestModuleShellWarm。
 * 不堵首帧；挂壳后仍由 ModuleVisibility.suspended / moduleLive 抑制 Live 重活。
 */
export function scheduleIdleOverlayShellWarm(
  options?: IdleOverlayShellWarmOptions,
): () => void {
  const keys = options?.keys ?? IDLE_OVERLAY_SHELL_KEYS;
  const initialShellTimeoutMs = options?.initialShellTimeoutMs ?? 8000;
  const stepShellTimeoutMs = options?.stepShellTimeoutMs ?? 2500;
  let cancelled = false;
  let cancelScheduled: (() => void) | null = null;
  let index = 0;

  const warmNext = () => {
    if (cancelled) return;
    while (index < keys.length && shellWarmRequested.has(keys[index]!)) {
      index += 1;
    }
    if (index >= keys.length) return;
    const key = keys[index]!;
    index += 1;
    void preloadOverlayModuleChunk(key).finally(() => {
      if (cancelled) return;
      requestModuleShellWarm(key);
      cancelScheduled = scheduleIdleOrTimeout(warmNext, stepShellTimeoutMs);
    });
  };

  cancelScheduled = scheduleIdleOrTimeout(warmNext, initialShellTimeoutMs);

  return () => {
    cancelled = true;
    cancelScheduled?.();
    cancelScheduled = null;
  };
}

/** @deprecated 使用 scheduleIdleOverlayShellWarm */
export function scheduleIdleTerminalWarm(options?: {
  chunkDelayMs?: number;
  shellDelayMs?: number;
}): () => void {
  return scheduleIdleOverlayShellWarm({
    keys: ["terminal"],
    initialShellTimeoutMs: options?.shellDelayMs ?? 8000,
    stepShellTimeoutMs: options?.chunkDelayMs ?? 2500,
  });
}

/** @deprecated 使用 scheduleIdleOverlayShellWarm */
export function scheduleIdleDatabaseWarm(options?: {
  chunkDelayMs?: number;
  shellDelayMs?: number;
}): () => void {
  return scheduleIdleOverlayShellWarm({
    keys: ["database"],
    initialShellTimeoutMs: options?.shellDelayMs ?? 12000,
    stepShellTimeoutMs: options?.chunkDelayMs ?? 4000,
  });
}

export const PRIORITY_OVERLAY_WARM_KEY = "terminal" as const satisfies OverlayModuleKey;

/** 供文档/调试：默认导航路径 */
export const DEFAULT_WARM_NAV_PATH = MODULE_PATHS.terminal;

/** 全部叠层 key（只读）；禁止用于首帧同步全挂 */
export const ALL_OVERLAY_MODULE_KEYS_FOR_WARMUP: readonly OverlayModuleKey[] =
  OVERLAY_MODULE_KEYS;
