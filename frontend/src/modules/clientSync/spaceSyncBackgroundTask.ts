/**
 * 空间 / 团队同步接入左下角全局后台任务。
 * 多路同步（自动推送、定时对齐、手动同步、启动拉取）共用同一条任务，避免刷屏。
 */
import { listen } from "@tauri-apps/api/event";
import { SPACE_SYNC_PROGRESS } from "../../ipc/events";
import { formatIpcError } from "../../ipc/result";
import {
  upsertLocalBackgroundTask,
  type BackgroundTaskInfo,
} from "../../stores/backgroundTaskStore";

export const SPACE_SYNC_TASK_ID = "client-space-sync";

const MODULE = "sync";
const KIND = "space-sync";

let activeCount = 0;
let startedAt = 0;
let currentTitle = "空间同步";
let currentPhase: SpaceSyncTaskPhase = "push";
let currentDone = 0;
let currentTotal = 0;
let hadFailure = false;
let lastError: string | null = null;
let progressListening = false;
let lastPaintAt = 0;
let paintTimer: ReturnType<typeof setTimeout> | null = null;

function makeTask(
  partial: Partial<BackgroundTaskInfo> &
    Pick<BackgroundTaskInfo, "status" | "progress">,
): BackgroundTaskInfo {
  return {
    id: SPACE_SYNC_TASK_ID,
    module: MODULE,
    kind: KIND,
    title: currentTitle,
    index: currentDone,
    total: currentTotal,
    rowCompleted: null,
    rowTotal: null,
    startedAt: startedAt || Date.now(),
    finishedAt: null,
    error: null,
    ...partial,
  };
}

export type SpaceSyncTaskPhase = "push" | "pull" | "merge";

function titleForPhase(phase: SpaceSyncTaskPhase): string {
  switch (phase) {
    case "pull":
      return "同步 · 拉取";
    case "merge":
      return "同步 · 合并";
    case "push":
    default:
      return "同步 · 推送";
  }
}

function progressForPhase(phase: SpaceSyncTaskPhase): string {
  switch (phase) {
    case "pull":
      return "正在从云端拉取…";
    case "merge":
      return "正在合并空间数据…";
    case "push":
    default:
      return "正在上传本机变更…";
  }
}

/** 开始一次同步；可嵌套，全部结束后才标记完成。 */
export function beginSpaceSyncTask(phase: SpaceSyncTaskPhase = "merge"): void {
  activeCount += 1;
  currentPhase = phase;
  currentTitle = titleForPhase(phase);
  initSpaceSyncProgress();
  if (activeCount === 1) {
    startedAt = Date.now();
    currentDone = 0;
    currentTotal = 0;
    lastPaintAt = 0;
    hadFailure = false;
    lastError = null;
  }
  upsertLocalBackgroundTask(
    makeTask({
      status: "running",
      progress: progressForPhase(phase),
      finishedAt: null,
      error: null,
    }),
  );
}

function paintSyncCount(): void {
  upsertLocalBackgroundTask(
    makeTask({
      status: "running",
      progress: progressForPhase(currentPhase),
      finishedAt: null,
      error: null,
    }),
  );
}

export function updateSpaceSyncCount(done: number, total: number): void {
  if (activeCount <= 0 || total <= 0) return;
  currentDone = done;
  currentTotal = total;
  const now = Date.now();
  const finished = done >= total;
  if (finished || now - lastPaintAt >= 80) {
    if (paintTimer != null) {
      clearTimeout(paintTimer);
      paintTimer = null;
    }
    lastPaintAt = now;
    paintSyncCount();
    return;
  }
  if (paintTimer != null) return;
  paintTimer = setTimeout(() => {
    paintTimer = null;
    lastPaintAt = Date.now();
    if (activeCount <= 0) return;
    paintSyncCount();
  }, 80);
}

export function initSpaceSyncProgress(): void {
  if (progressListening) return;
  progressListening = true;
  void listen<{ done?: number; total?: number }>(SPACE_SYNC_PROGRESS, (event) => {
    const done = Number(event.payload?.done ?? 0);
    const total = Number(event.payload?.total ?? 0);
    if (!Number.isFinite(done) || !Number.isFinite(total)) return;
    updateSpaceSyncCount(done, total);
  });
}

export function updateSpaceSyncTask(progress: string): void {
  if (activeCount <= 0) return;
  upsertLocalBackgroundTask(
    makeTask({
      status: "running",
      progress,
      finishedAt: null,
      error: null,
    }),
  );
}

/** 结束一次同步；全部嵌套结束后写入完成/失败态。 */
export function finishSpaceSyncTask(options?: {
  ok?: boolean;
  progress?: string;
  error?: unknown;
}): void {
  if (activeCount <= 0) return;
  const ok = options?.ok !== false && options?.error == null;
  if (!ok) {
    hadFailure = true;
    lastError =
      options?.error != null
        ? formatIpcError(options.error)
        : (options?.progress ?? "同步失败");
  }
  activeCount -= 1;
  if (activeCount > 0) {
    upsertLocalBackgroundTask(
      makeTask({
        status: "running",
        progress: options?.progress ?? progressForPhase("merge"),
        finishedAt: null,
        error: null,
      }),
    );
    return;
  }

  if (paintTimer != null) {
    clearTimeout(paintTimer);
    paintTimer = null;
  }
  const failed = hadFailure;
  upsertLocalBackgroundTask(
    makeTask({
      title: "空间同步",
      status: failed ? "failed" : "completed",
      progress: failed
        ? (options?.progress ?? "同步失败")
        : (options?.progress ?? "已同步"),
      finishedAt: Date.now(),
      error: failed ? lastError : null,
    }),
  );
  startedAt = 0;
  hadFailure = false;
  lastError = null;
}

/** 包裹一次异步同步；自动 begin/finish。 */
export async function withSpaceSyncTask<T>(
  phase: SpaceSyncTaskPhase,
  run: () => Promise<T>,
  doneProgress?: (result: T) => string | undefined,
): Promise<T> {
  beginSpaceSyncTask(phase);
  try {
    const result = await run();
    finishSpaceSyncTask({
      ok: true,
      progress: doneProgress?.(result),
    });
    return result;
  } catch (error) {
    finishSpaceSyncTask({ ok: false, error });
    throw error;
  }
}
