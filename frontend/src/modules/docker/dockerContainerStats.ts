import { commands } from "../../ipc/bindings";
import type { DockerContainerStats, DockerContainerSummary } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { debugStats, warnStats } from "./dockerStatsDebug";

/** 默认 stats 轮询间隔（空闲） */
export const DOCKER_STATS_POLL_MS = 5000;
/** 运行中容器较多时的降频间隔 */
export const DOCKER_STATS_POLL_MS_BUSY = 8000;
/** 容器列表轮询：低于 stats，避免与全量 stats 同频双冲击 */
export const DOCKER_CONTAINERS_POLL_MS = 12_000;
/** 首帧先拉容器列表，stats 稍后错开启动 */
export const DOCKER_STATS_INITIAL_DELAY_MS = 800;
export const DOCKER_STATS_REQUEST_TIMEOUT_MS = 45_000;

const unwrap = unwrapCommand;

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
  const scopeCount = containerIds?.length ?? null;
  const startedAt = performance.now();
  debugStats("IPC 开始", {
    connectionId,
    scope: scopeCount == null ? "all" : scopeCount,
    timeoutMs: DOCKER_STATS_REQUEST_TIMEOUT_MS,
  });
  try {
    const result = await withTimeout(
      unwrap(listStats(connectionId, containerIds), { quiet: true }),
      DOCKER_STATS_REQUEST_TIMEOUT_MS,
      "dockerListContainerStats",
    );
    debugStats("IPC 成功", {
      connectionId,
      elapsedMs: Math.round(performance.now() - startedAt),
      resultCount: result.length,
    });
    return result;
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    warnStats("IPC 失败/超时", {
      connectionId,
      scope: scopeCount == null ? "all" : scopeCount,
      elapsedMs,
      timeoutMs: DOCKER_STATS_REQUEST_TIMEOUT_MS,
      error: String(error),
      hint:
        elapsedMs >= DOCKER_STATS_REQUEST_TIMEOUT_MS - 50
          ? "前端超时；后端可能仍在执行（SSH 绑定连接常见原因：日志流/终端曾占满 exec 闸门，或远端 docker stats 过慢）"
          : "非超时错误，见 error 字段",
    });
    throw error;
  }
}
