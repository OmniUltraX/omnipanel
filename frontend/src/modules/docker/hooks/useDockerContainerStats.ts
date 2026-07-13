import { useCallback, useEffect, useRef, useState } from "react";
import type { DockerContainerStats } from "../../../ipc/bindings";
import {
  DOCKER_STATS_POLL_MS,
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
  enabled?: boolean;
};

/**
 * 容器 stats 轮询：与容器列表解耦，只负责拉取并维护 stats Map。
 */
export function useDockerContainerStats(
  connectionId: string | null,
  options?: UseDockerContainerStatsOptions,
) {
  const enabled = options?.enabled ?? true;
  const pollMs = options?.pollMs ?? DOCKER_STATS_POLL_MS;

  const [statsById, setStatsById] = useState<Map<string, DockerContainerStats>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const inflightRef = useRef(false);
  const requestGenRef = useRef(0);
  const refreshRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    if (!enabled || !connectionId) {
      setStatsById(new Map());
      setError(null);
      return;
    }

    let cancelled = false;

    const refresh = async () => {
      if (inflightRef.current) return;
      inflightRef.current = true;
      const requestGen = ++requestGenRef.current;
      try {
        // 始终拉全量 stats，由前端 pickStats 做 ID/名称匹配（避免 scoped 请求与 docker 输出不一致）。
        const statsList = await fetchDockerContainerStats(connectionId, null);
        if (cancelled || requestGen !== requestGenRef.current) return;
        setStatsById(statsMapFromList(statsList));
        setError(null);
      } catch (e) {
        if (cancelled || requestGen !== requestGenRef.current) return;
        setError(String(e));
      } finally {
        inflightRef.current = false;
      }
    };

    refreshRef.current = refresh;

    void refresh();
    const timer = window.setInterval(() => void refresh(), pollMs);

    return () => {
      cancelled = true;
      requestGenRef.current += 1;
      refreshRef.current = null;
      window.clearInterval(timer);
    };
  }, [connectionId, enabled, pollMs]);

  const refreshNow = useCallback(() => {
    void refreshRef.current?.();
  }, []);

  return { statsById, error, refreshNow };
}

export { runningContainerIds };
