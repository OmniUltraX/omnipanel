/**
 * 前端本地耗时操作 → 左下角后台任务。
 * 凡是可能超过约 1s、且不挡主流程的异步活，优先用这个包一层。
 */
import { formatIpcError } from "../ipc/result";
import {
  upsertLocalBackgroundTask,
  type BackgroundTaskInfo,
} from "../stores/backgroundTaskStore";

export type LocalBackgroundTaskContext = {
  setProgress: (progress: string) => void;
  setTitle: (title: string) => void;
};

export type RunLocalBackgroundTaskOptions<T> = {
  id: string;
  module: string;
  kind: string;
  title: string;
  /** 初始进度文案 */
  progress?: string;
  run: (ctx: LocalBackgroundTaskContext) => Promise<T>;
  successProgress?: string | ((result: T) => string);
  failureProgress?: string;
};

function baseFields(
  options: Pick<RunLocalBackgroundTaskOptions<unknown>, "id" | "module" | "kind" | "title">,
  startedAt: number,
): Pick<
  BackgroundTaskInfo,
  | "id"
  | "module"
  | "kind"
  | "title"
  | "index"
  | "total"
  | "rowCompleted"
  | "rowTotal"
  | "startedAt"
> {
  return {
    id: options.id,
    module: options.module,
    kind: options.kind,
    title: options.title,
    index: 0,
    total: 0,
    rowCompleted: null,
    rowTotal: null,
    startedAt,
  };
}

/** 包裹一次本地异步耗时操作，进度写入左下角任务列表。 */
export async function runLocalBackgroundTask<T>(
  options: RunLocalBackgroundTaskOptions<T>,
): Promise<T> {
  const startedAt = Date.now();
  let title = options.title;
  let progress = options.progress ?? "进行中…";

  const publish = (
    partial: Pick<BackgroundTaskInfo, "status" | "progress"> &
      Partial<Pick<BackgroundTaskInfo, "finishedAt" | "error">>,
  ) => {
    upsertLocalBackgroundTask({
      ...baseFields({ ...options, title }, startedAt),
      finishedAt: null,
      error: null,
      ...partial,
    });
  };

  const ctx: LocalBackgroundTaskContext = {
    setProgress: (next) => {
      progress = next;
      publish({ status: "running", progress, finishedAt: null, error: null });
    },
    setTitle: (next) => {
      title = next;
      publish({ status: "running", progress, finishedAt: null, error: null });
    },
  };

  publish({
    status: "running",
    progress,
  });

  try {
    const result = await options.run(ctx);
    const progress =
      typeof options.successProgress === "function"
        ? options.successProgress(result)
        : (options.successProgress ?? "完成");
    publish({
      status: "completed",
      progress,
      finishedAt: Date.now(),
      error: null,
    });
    return result;
  } catch (error) {
    publish({
      status: "failed",
      progress: options.failureProgress ?? "失败",
      finishedAt: Date.now(),
      error: formatIpcError(error),
    });
    throw error;
  }
}
