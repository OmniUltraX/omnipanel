import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import type { DockerContainerStats } from "../../../ipc/bindings";
import {
  DOCKER_STATS_POLL_MS,
  DOCKER_STATS_POLL_MS_BUSY,
  fetchDockerContainerStats,
  runningContainerIds,
} from "../dockerContainerStats";
import { statsMapFromList } from "../dockerContainerStatsMatch";

export type UseDockerContainerStatsOptions = {
  /** 显式指定容器 ID；未设置则每次轮询用 `resolveContainerIds` 动态解析 */
  containerIds?: string[] | null;
  /** 动态解析 scoped 容器 ID（如从 containers 列表） */
  resolveContainerIds?: () => string[];
  pollMs?: number;
  /** 首次拉取前延迟，用于与容器列表请求错开 */
  initialDelayMs?: number;
  enabled?: boolean;
};

/** 按连接缓存最近一次成功的 stats；面板重开/重挂先展示，拉取成功后再覆盖。 */
const statsCacheByConnectionId = new Map<string, Map<string, DockerContainerStats>>();

/** ≥ 此数量运行中容器时自动降频轮询 */
const BUSY_RUNNING_THRESHOLD = 10;

function readStatsCache(connectionId: string | null): Map<string, DockerContainerStats> {
  if (!connectionId) return new Map();
  const cached = statsCacheByConnectionId.get(connectionId);
  return cached ? new Map(cached) : new Map();
}

function writeStatsCache(connectionId: string, stats: Map<string, DockerContainerStats>) {
  statsCacheByConnectionId.set(connectionId, stats);
}

/** 展示/比较用：百分数量化到 0.1，避免浮点微变触发重渲染 */
function quantizePercent(value: number | null | undefined): number {
  if (value == null || Number.isNaN(value)) return 0;
  return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
}

function normalizeStatsEntry(stats: DockerContainerStats): DockerContainerStats {
  return {
    ...stats,
    cpuPercent: quantizePercent(stats.cpuPercent),
    memoryPercent: quantizePercent(stats.memoryPercent),
  };
}

function normalizeStatsMap(raw: Map<string, DockerContainerStats>): Map<string, DockerContainerStats> {
  const next = new Map<string, DockerContainerStats>();
  for (const [key, value] of raw) {
    next.set(key, normalizeStatsEntry(value));
  }
  return next;
}

function statsMapsEqual(
  a: Map<string, DockerContainerStats>,
  b: Map<string, DockerContainerStats>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, av] of a) {
    const bv = b.get(key);
    if (!bv) return false;
    if (
      av.containerId !== bv.containerId ||
      av.name !== bv.name ||
      av.cpuPercent !== bv.cpuPercent ||
      av.memoryPercent !== bv.memoryPercent ||
      av.memoryUsageBytes !== bv.memoryUsageBytes ||
      av.memoryLimitBytes !== bv.memoryLimitBytes
    ) {
      return false;
    }
  }
  return true;
}

function documentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/**
 * 容器 stats 轮询：与容器列表解耦，只负责拉取并维护 stats Map。
 * 打开面板时先用缓存数据，docker stats 成功返回后再更新。
 * 写入前量化 + 等值短路；页面不可见时暂停轮询。
 */
export function useDockerContainerStats(
  connectionId: string | null,
  options?: UseDockerContainerStatsOptions,
) {
  const enabled = options?.enabled ?? true;
  const basePollMs = options?.pollMs ?? DOCKER_STATS_POLL_MS;
  const initialDelayMs = options?.initialDelayMs ?? 0;

  const [statsById, setStatsById] = useState(() => readStatsCache(connectionId));
  const [error, setError] = useState<string | null>(null);
  const [pageVisible, setPageVisible] = useState(documentVisible);
  const inflightRef = useRef(false);
  const pendingRefreshRef = useRef(false);
  const requestGenRef = useRef(0);
  const refreshRef = useRef<(() => Promise<void>) | null>(null);
  const statsByIdRef = useRef(statsById);
  statsByIdRef.current = statsById;
  const resolveContainerIdsRef = useRef(options?.resolveContainerIds);
  resolveContainerIdsRef.current = options?.resolveContainerIds;

  useEffect(() => {
    const onVisibility = () => setPageVisible(documentVisible());
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // 换连接：立刻切到该连接的缓存（无缓存则为空）；切走面板仅停轮询，不清模块缓存
  useEffect(() => {
    setStatsById(readStatsCache(connectionId));
    setError(null);
  }, [connectionId]);

  const polling = enabled && pageVisible && Boolean(connectionId);

  useEffect(() => {
    if (!polling || !connectionId) {
      refreshRef.current = null;
      pendingRefreshRef.current = false;
      return;
    }

    let cancelled = false;
    let timer: number | null = null;

    const clearTimer = () => {
      if (timer != null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const scheduleNext = (delayMs: number) => {
      if (cancelled) return;
      clearTimer();
      timer = window.setTimeout(() => {
        timer = null;
        void refresh();
      }, delayMs);
    };

    const refresh = async () => {
      if (cancelled) return;
      if (inflightRef.current) {
        // 避免 soft-refresh / 重挂时「inflight 早退且不再 schedule」把轮询永久掐死
        pendingRefreshRef.current = true;
        return;
      }
      if (!documentVisible()) {
        scheduleNext(basePollMs);
        return;
      }

      inflightRef.current = true;
      pendingRefreshRef.current = false;
      const requestGen = ++requestGenRef.current;
      let nextPollMs = basePollMs;
      try {
        // 始终拉全量 stats，由前端 pickStats 做 ID/名称匹配（避免 scoped 请求与 docker 输出不一致）。
        const statsList = await fetchDockerContainerStats(connectionId, null);
        if (cancelled || requestGen !== requestGenRef.current) return;
        const next = normalizeStatsMap(statsMapFromList(statsList));
        writeStatsCache(connectionId, next);

        const resolvedIds = resolveContainerIdsRef.current?.() ?? null;
        const runningCount = resolvedIds?.length ?? new Set(
          [...next.keys()].filter((key) => !key.startsWith("name:") && key.length >= 12),
        ).size;
        if (runningCount >= BUSY_RUNNING_THRESHOLD) {
          nextPollMs = Math.max(basePollMs, DOCKER_STATS_POLL_MS_BUSY);
        }

        if (!statsMapsEqual(statsByIdRef.current, next)) {
          statsByIdRef.current = next;
          // stats 更新降优先级，避免挤掉侧栏/概览卡片交互帧
          startTransition(() => {
            setStatsById(next);
          });
        }
        setError(null);
      } catch (e) {
        if (cancelled || requestGen !== requestGenRef.current) return;
        // 失败时保留已有缓存展示，仅记录错误
        setError(String(e));
      } finally {
        inflightRef.current = false;
        if (cancelled) return;
        if (pendingRefreshRef.current) {
          pendingRefreshRef.current = false;
          scheduleNext(0);
        } else {
          scheduleNext(nextPollMs);
        }
      }
    };

    refreshRef.current = refresh;

    if (initialDelayMs > 0) {
      scheduleNext(initialDelayMs);
    } else {
      void refresh();
    }

    return () => {
      cancelled = true;
      requestGenRef.current += 1;
      refreshRef.current = null;
      pendingRefreshRef.current = false;
      // 允许下一轮 effect 立刻发起请求，忽略仍在飞行的旧请求结果（靠 requestGen）
      inflightRef.current = false;
      clearTimer();
    };
  }, [basePollMs, connectionId, initialDelayMs, polling]);

  const refreshNow = useCallback(() => {
    void refreshRef.current?.();
  }, []);

  return { statsById, error, refreshNow };
}

export { runningContainerIds };
