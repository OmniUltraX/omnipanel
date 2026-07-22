import type { OverlayModuleKey } from "./routePanels";
import { isOverlayModuleKey } from "./routePanels";
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

const chunkInflight = new Map<OverlayModuleKey, Promise<void>>();
const chunkReady = new Set<OverlayModuleKey>();

type ShellWarmListener = (key: OverlayModuleKey) => void;
const shellWarmListeners = new Set<ShellWarmListener>();

/** 订阅「预挂载模块壳」请求（不激活路由，仅让 Overlay 提前 mount） */
export function subscribeModuleShellWarm(listener: ShellWarmListener): () => void {
  shellWarmListeners.add(listener);
  return () => {
    shellWarmListeners.delete(listener);
  };
}

/** 请求预挂载模块壳；调用方应在 startTransition 中更新 mounted 状态 */
export function requestModuleShellWarm(key: OverlayModuleKey): void {
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

/** 空闲优先预热：终端 chunk → 请求挂载终端壳（仍 suspended，不建 xterm） */
export function scheduleIdleTerminalWarm(options?: {
  chunkDelayMs?: number;
  shellDelayMs?: number;
}): () => void {
  const chunkDelayMs = options?.chunkDelayMs ?? 2500;
  const shellDelayMs = options?.shellDelayMs ?? 8000;
  let cancelled = false;
  const timers: number[] = [];
  let idleChunkId: number | null = null;
  let idleShellId: number | null = null;

  const warmChunk = () => {
    if (cancelled) return;
    void preloadOverlayModuleChunk("terminal");
  };

  const warmShell = () => {
    if (cancelled) return;
    // 壳预挂载前确保 chunk 已在途
    void preloadOverlayModuleChunk("terminal").finally(() => {
      if (!cancelled) requestModuleShellWarm("terminal");
    });
  };

  if (typeof requestIdleCallback === "function") {
    idleChunkId = requestIdleCallback(warmChunk, { timeout: chunkDelayMs });
    idleShellId = requestIdleCallback(warmShell, { timeout: shellDelayMs });
  } else {
    timers.push(window.setTimeout(warmChunk, chunkDelayMs));
    timers.push(window.setTimeout(warmShell, shellDelayMs));
  }

  return () => {
    cancelled = true;
    if (idleChunkId != null && typeof cancelIdleCallback === "function") {
      cancelIdleCallback(idleChunkId);
    }
    if (idleShellId != null && typeof cancelIdleCallback === "function") {
      cancelIdleCallback(idleShellId);
    }
    for (const id of timers) window.clearTimeout(id);
  };
}

/** 空闲预热数据库：仅拉 chunk + 可选挂壳，不探测远端连接 */
export function scheduleIdleDatabaseWarm(options?: {
  chunkDelayMs?: number;
  shellDelayMs?: number;
}): () => void {
  const chunkDelayMs = options?.chunkDelayMs ?? 4000;
  const shellDelayMs = options?.shellDelayMs ?? 12000;
  let cancelled = false;
  const timers: number[] = [];
  let idleChunkId: number | null = null;
  let idleShellId: number | null = null;

  const warmChunk = () => {
    if (cancelled) return;
    void preloadOverlayModuleChunk("database");
  };

  const warmShell = () => {
    if (cancelled) return;
    void preloadOverlayModuleChunk("database").finally(() => {
      if (!cancelled) requestModuleShellWarm("database");
    });
  };

  if (typeof requestIdleCallback === "function") {
    idleChunkId = requestIdleCallback(warmChunk, { timeout: chunkDelayMs });
    idleShellId = requestIdleCallback(warmShell, { timeout: shellDelayMs });
  } else {
    timers.push(window.setTimeout(warmChunk, chunkDelayMs));
    timers.push(window.setTimeout(warmShell, shellDelayMs));
  }

  return () => {
    cancelled = true;
    if (idleChunkId != null && typeof cancelIdleCallback === "function") {
      cancelIdleCallback(idleChunkId);
    }
    if (idleShellId != null && typeof cancelIdleCallback === "function") {
      cancelIdleCallback(idleShellId);
    }
    for (const id of timers) window.clearTimeout(id);
  };
}

export const PRIORITY_OVERLAY_WARM_KEY = "terminal" as const satisfies OverlayModuleKey;

/** 供文档/调试：默认导航路径 */
export const DEFAULT_WARM_NAV_PATH = MODULE_PATHS.terminal;
