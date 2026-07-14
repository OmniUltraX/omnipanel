import { commands } from "../../ipc/bindings";
import type { DockerContainerStats, DockerContainerSummary } from "../../ipc/bindings";

/** 默认 stats 轮询间隔（空闲） */
export const DOCKER_STATS_POLL_MS = 3000;
/** 运行中容器较多时的降频间隔 */
export const DOCKER_STATS_POLL_MS_BUSY = 5000;
export const DOCKER_STATS_REQUEST_TIMEOUT_MS = 45_000;

async function unwrap<T>(
  promise: Promise<{ status: "ok"; data: T } | { status: "error"; error: { message: string } }>,
): Promise<T> {
  const res = await promise;
  if (res.status === "ok") return res.data;
  throw new Error(res.error.message);
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(`${label} 超时 (${ms}ms)`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer != null) window.clearTimeout(timer);
  }
}

/** 从容器列表提取运行中容器的 ID（用于 scoped stats 请求）。 */
export function runningContainerIds(containers: DockerContainerSummary[]): string[] {
  return containers
    .filter((container) => container.running)
    .map((container) => container.id)
    .filter((id) => id.trim().length > 0);
}

/** 拉取容器 CPU / 内存 stats；`null` 表示全量运行中容器。 */
export async function fetchDockerContainerStats(
  connectionId: string,
  containerIds: string[] | null,
): Promise<DockerContainerStats[]> {
  const listStats = commands.dockerListContainerStats;
  if (typeof listStats !== "function") {
    throw new Error("dockerListContainerStats 未绑定，请重启 tauri dev");
  }
  return withTimeout(
    unwrap(listStats(connectionId, containerIds)),
    DOCKER_STATS_REQUEST_TIMEOUT_MS,
    "dockerListContainerStats",
  );
}
