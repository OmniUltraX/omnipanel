const PREFIX = "[docker-stats]";

/** 输出容器 stats 调试信息（使用 console.log，默认日志级别可见）。控制台过滤 `docker-stats`。 */
export function debugDockerStats(message: string, data?: Record<string, unknown>): void {
  if (data !== undefined) {
    console.log(PREFIX, message, data);
    return;
  }
  console.log(PREFIX, message);
}

export function normalizeStatsId(id: string): string {
  return id.trim().toLowerCase().replace(/^sha256:/, "");
}

/** 描述后端实际执行的 stats 拉取方式（供前端对照 IPC 日志）。 */
export function describeStatsBackendCommand(
  connectionSource: "local" | "remote" | "ssh" | "onepanel" | "unknown",
  containerIds: string[] | null | undefined,
): string {
  const scoped =
    containerIds == null
      ? "全部运行中容器"
      : containerIds.length === 0
        ? "（空列表，跳过）"
        : containerIds.join(" ");
  switch (connectionSource) {
    case "local":
    case "remote":
      return `bollard stats API（one-shot 双帧采样） ids=${scoped}`;
    case "ssh":
      return `ssh exec: docker stats --no-stream --format '{{json .}}' ${scoped}`.trim();
    case "onepanel":
      return `GET /api/v2/containers/list/stats（再按 ids 过滤: ${scoped}）`;
    default:
      return `docker_list_container_stats(containerIds=${scoped})`;
  }
}

/** IPC 请求/响应调试：记录 invoke 参数与原始返回。 */
export function debugDockerStatsIpc(
  phase: "request" | "response" | "error",
  meta: {
    connectionId: string;
    containerIds?: string[] | null;
    label?: string;
    source?: "local" | "remote" | "ssh" | "onepanel" | "unknown";
  },
  extra?: Record<string, unknown>,
): void {
  const containerIds = meta.containerIds ?? null;
  const base: Record<string, unknown> = {
    phase,
    connectionId: meta.connectionId,
    label: meta.label,
    containerIds,
    containerIdCount: containerIds?.length ?? null,
    containerIdSample: containerIds?.slice(0, 5),
    ...extra,
  };

  if (phase === "request") {
    debugDockerStats("IPC dockerListContainerStats 请求", {
      ...base,
      invoke: "docker_list_container_stats",
      backendHint: describeStatsBackendCommand(meta.source ?? "unknown", containerIds),
      ...extra,
    });
    return;
  }

  if (phase === "error") {
    debugDockerStats("IPC dockerListContainerStats 失败", base);
    return;
  }

  debugDockerStats("IPC dockerListContainerStats 响应", base);
}

/** 将 stats 列表压缩为可读的调试摘要。 */
export function summarizeStatsList(
  statsList: Array<{
    containerId: string;
    name: string;
    cpuPercent: number;
    memoryPercent: number;
    memoryUsageBytes: number;
    memoryLimitBytes?: number | null;
    timestampMs: number;
  }>,
  maxItems = 5,
): Record<string, unknown> {
  return {
    count: statsList.length,
    sample: statsList.slice(0, maxItems).map((item) => ({
      containerId: item.containerId,
      name: item.name,
      cpuPercent: item.cpuPercent,
      memoryPercent: item.memoryPercent,
      memoryUsageBytes: item.memoryUsageBytes,
      memoryLimitBytes: item.memoryLimitBytes ?? null,
      timestampMs: item.timestampMs,
    })),
    raw: statsList.slice(0, maxItems),
  };
}
