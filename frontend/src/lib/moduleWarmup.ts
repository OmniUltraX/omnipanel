import type { OverlayModuleKey } from "./routePanels";
import { isOverlayModuleKey, OVERLAY_MODULE_KEYS } from "./routePanels";
import { moduleKeyFromPath, MODULE_PATHS } from "./paths";

type ModuleChunkLoader = () => Promise<unknown>;

const OVERLAY_CHUNK_LOADERS: Record<OverlayModuleKey, ModuleChunkLoader> = {
  terminal: () => import("../modules/terminal/TerminalPanel"),
  ssh: () => import("../modules/server/SshPanel"),
  database: () => import("../modules/database/DatabasePanel"),
  docker: () => import("../modules/docker/DockerPanel"),
  files: () => import("../modules/files/FilesPanel"),
  server: () => import("../modules/server/ServerPanel"),
  protocol: () => import("../modules/protocol/ProtocolPanel"),
  workflow: () => import("../modules/workflow/WorkflowPanel"),
  knowledge: () => import("../modules/knowledge/KnowledgePanel"),
  tasks: () => import("../modules/tasks/TaskCenterPanel"),
  cloud: () => import("../modules/cloud/CloudPanel"),
};

/** 空闲 Shell 预热顺序：终端优先，与 chunk 预热一致 */
export const IDLE_OVERLAY_SHELL_KEYS: readonly OverlayModuleKey[] = [
  "terminal",
  "ssh",
  "database",
  "docker",
  "server",
  "files",
  "cloud",
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

/**
 * 真实延迟 + 空闲对齐：先睡足 timeoutMs（ wall clock，意图即“多久以后再说”），
 * 到点后再要一个空闲槽（2s 兜底）。直接用 requestIdleCallback 的 timeout 语义
 * 会在首屏空闲时立刻开火——启动期三个预热调度会同时 stampede 主线程数秒，
 * hover 都没反应。所有后台预热必须走这里，禁止裸 rIC。
 */
function scheduleIdleOrTimeout(run: () => void, timeoutMs: number): () => void {
  let settled = false;
  let timer: number | null = null;
  let cancelIdle: (() => void) | null = null;
  const fire = () => {
    if (settled) return;
    settled = true;
    run();
  };
  timer = window.setTimeout(() => {
    timer = null;
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(fire, { timeout: 2000 });
      cancelIdle = () => {
        if (typeof cancelIdleCallback === "function") cancelIdleCallback(id);
      };
      return;
    }
    fire();
  }, Math.max(0, timeoutMs));
  return () => {
    settled = true;
    if (timer) window.clearTimeout(timer);
    timer = null;
    cancelIdle?.();
    cancelIdle = null;
  };
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
  if (!shouldPremountShell()) return;
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

/** 当前会话已请求预挂壳的模块快照（outlet 合并进挂载集；只增不减） */
export function listShellWarmRequested(): OverlayModuleKey[] {
  return [...shellWarmRequested];
}

const PREMOUNT_FLAG = "omnipanel.warm.premount";

/**
 * 壳预挂总开关（默认开）：localStorage 置 "0" 则只预热 chunk、不挂壳，
 * 用于二分预挂载的内存/耗时影响。chunk 预热不受影响。
 */
export function shouldPremountShell(): boolean {
  try {
    return window.localStorage.getItem(PREMOUNT_FLAG) !== "0";
  } catch {
    return true;
  }
}

/** 侧栏路径 → 叠层模块 key；非叠层返回 null */
export function overlayKeyFromNavPath(path: string): OverlayModuleKey | null {
  const key = moduleKeyFromPath(path);
  return isOverlayModuleKey(key) ? key : null;
}

/**
 * 悬停意图：预拉 JS chunk + 请求挂壳（suspended）。
 * 悬停到点击通常有 200ms+，壳先挂上，首访只剩数据显示。
 * 返回取消函数（mouseleave 时调用；已发出的请求不撤回，无害）。
 */
export function scheduleNavHoverWarm(
  path: string,
  _hoverMs = 140,
): () => void {
  const key = overlayKeyFromNavPath(path);
  if (!key) return () => {};
  void preloadOverlayModuleChunk(key);
  requestModuleShellWarm(key);
  return () => {};
}

export interface IdleOverlayShellWarmOptions {
  keys?: readonly OverlayModuleKey[];
  /** 首个模块开始 chunk 预热的 idle timeout（ms） */
  initialShellTimeoutMs?: number;
  /** 后续每个模块之间的 idle timeout（ms） */
  stepShellTimeoutMs?: number;
}

/**
 * 空闲错峰：按序逐个“chunk 预拉 + 请求挂壳（suspended）”。
 * retain-all 时代挂壳不再与保活冲突：反正挂上就不卸，早挂就是把
 * 首访的 chunk 下载 + React 挂载提前到空闲时付，xterm 初始化
 * 仍受 active/visible 门禁，不会在后台一次性全起。
 */
export function scheduleIdleOverlayShellWarm(
  options?: IdleOverlayShellWarmOptions,
): () => void {
  const keys = options?.keys ?? IDLE_OVERLAY_SHELL_KEYS;
  const initialShellTimeoutMs = options?.initialShellTimeoutMs ?? 2500;
  const stepShellTimeoutMs = options?.stepShellTimeoutMs ?? 1200;
  let cancelled = false;
  let cancelScheduled: (() => void) | null = null;
  let index = 0;

  const warmNext = () => {
    if (cancelled) return;
    while (index < keys.length && chunkReady.has(keys[index]!)) {
      index += 1;
    }
    if (index >= keys.length) return;
    const key = keys[index]!;
    index += 1;
    void preloadOverlayModuleChunk(key).finally(() => {
      if (cancelled) return;
      // chunk 就绪后再挂壳：挂载 suspended 树只付 React 成本，数据 effect
      // 被 moduleLive 门禁挡住，xterm 初始化被 active/visible 门禁挡住。
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
