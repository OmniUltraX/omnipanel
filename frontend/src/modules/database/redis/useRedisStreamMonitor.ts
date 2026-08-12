import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  redisStreamMonitor,
  redisStreamPending,
  type DbConnectionConfig,
  type RedisStreamConsumer,
  type RedisStreamGroup,
  type RedisStreamMonitorSnapshot,
  type RedisStreamPendingEntry,
} from "../api";

interface RateSample {
  at: number;
  lag: number;
  entriesRead: number;
}

export interface RedisStreamRateStats {
  lagDelta: number;
  rate: number;
  activeConsumers: number;
  catchUpHours: number | null;
  lag: number;
}

export interface UseRedisStreamMonitorOptions {
  connection: DbConnectionConfig;
  streamKey: string | null;
  enabled?: boolean;
}

export interface RedisStreamMonitorState {
  snapshot: RedisStreamMonitorSnapshot | null;
  pending: RedisStreamPendingEntry[];
  selectedGroup: string | null;
  setSelectedGroup: (name: string | null) => void;
  selectedConsumer: string | null;
  setSelectedConsumer: (name: string | null) => void;
  selectedGroupRow: RedisStreamGroup | null;
  filteredPending: RedisStreamPendingEntry[];
  loading: boolean;
  error: string | null;
  autoRefresh: boolean;
  setAutoRefresh: (value: boolean) => void;
  refresh: () => Promise<void>;
  rateStats: RedisStreamRateStats | null;
}

function streamIdTs(id: string | null | undefined): Date | null {
  if (!id) {
    return null;
  }
  const ms = Number.parseInt(id.split("-")[0] ?? "", 10);
  if (!Number.isFinite(ms)) {
    return null;
  }
  return new Date(ms);
}

export function formatStreamIdTime(id: string | null | undefined): string {
  return streamIdTs(id)?.toLocaleString() ?? "—";
}

export function useRedisStreamMonitor({
  connection,
  streamKey,
  enabled = true,
}: UseRedisStreamMonitorOptions): RedisStreamMonitorState {
  const [snapshot, setSnapshot] = useState<RedisStreamMonitorSnapshot | null>(null);
  const [pending, setPending] = useState<RedisStreamPendingEntry[]>([]);
  const [selectedGroup, setSelectedGroupState] = useState<string | null>(null);
  const [selectedConsumer, setSelectedConsumer] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [rateStats, setRateStats] = useState<RedisStreamRateStats | null>(null);
  const samplesRef = useRef<RateSample[]>([]);
  const sampleGroupRef = useRef<string | null>(null);

  const loadSnapshot = useCallback(
    async (groupHint?: string | null) => {
      if (!streamKey) {
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const data = await redisStreamMonitor(
          connection,
          streamKey,
          groupHint ?? undefined,
        );
        setSnapshot(data);
        const groupName =
          groupHint && data.groups.some((g) => g.name === groupHint)
            ? groupHint
            : (data.groups[0]?.name ?? null);
        if (groupName !== selectedGroup) {
          setSelectedGroupState(groupName);
          setSelectedConsumer(null);
        }
        if (sampleGroupRef.current !== groupName) {
          samplesRef.current = [];
          sampleGroupRef.current = groupName;
          setRateStats(null);
        }
        if (groupName) {
          const pendingRows = await redisStreamPending(connection, streamKey, groupName);
          setPending(pendingRows);
          const groupRow = data.groups.find((g) => g.name === groupName);
          if (groupRow?.lag != null && groupRow.entriesRead != null) {
            const now = Date.now();
            const samples = [
              ...samplesRef.current,
              { at: now, lag: groupRow.lag, entriesRead: groupRow.entriesRead },
            ];
            samplesRef.current = samples.slice(-12);
            if (samples.length >= 2) {
              const prev = samples[samples.length - 2];
              const curr = samples[samples.length - 1];
              const dt = (curr.at - prev.at) / 1000;
              if (dt > 0) {
                const lagDelta = prev.lag - curr.lag;
                const rate = (curr.entriesRead - prev.entriesRead) / dt;
                const activeConsumers = data.consumers.filter((c) => c.active).length;
                const catchUpHours =
                  lagDelta > 0 && curr.lag > 0 ? curr.lag / (lagDelta / dt) / 3600 : null;
                setRateStats({ lagDelta, rate, activeConsumers, catchUpHours, lag: curr.lag });
              }
            }
          }
        } else {
          setPending([]);
          setRateStats(null);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [connection, selectedGroup, streamKey],
  );

  useEffect(() => {
    if (!streamKey) {
      setSnapshot(null);
      setPending([]);
      setSelectedGroupState(null);
      setSelectedConsumer(null);
      samplesRef.current = [];
      sampleGroupRef.current = null;
      setRateStats(null);
    }
  }, [streamKey]);

  const setSelectedGroup = useCallback(
    (name: string | null) => {
      setSelectedGroupState(name);
      setSelectedConsumer(null);
      samplesRef.current = [];
      sampleGroupRef.current = name;
      setRateStats(null);
      if (name && streamKey && enabled) {
        void loadSnapshot(name);
      }
    },
    [enabled, loadSnapshot, streamKey],
  );

  const refresh = useCallback(async () => {
    await loadSnapshot(selectedGroup);
  }, [loadSnapshot, selectedGroup]);

  useEffect(() => {
    if (!enabled || !streamKey) {
      return;
    }
    void loadSnapshot(selectedGroup);
  }, [enabled, loadSnapshot, streamKey]);

  useEffect(() => {
    if (!enabled || !autoRefresh || !streamKey) {
      return;
    }
    const timer = window.setInterval(() => void loadSnapshot(selectedGroup), 10_000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, enabled, loadSnapshot, selectedGroup, streamKey]);

  const selectedGroupRow = useMemo(
    () => snapshot?.groups.find((g) => g.name === selectedGroup) ?? null,
    [selectedGroup, snapshot?.groups],
  );

  const filteredPending = useMemo(() => {
    if (!selectedConsumer) {
      return pending;
    }
    return pending.filter((p) => p.consumer === selectedConsumer);
  }, [pending, selectedConsumer]);

  return {
    snapshot,
    pending,
    selectedGroup,
    setSelectedGroup,
    selectedConsumer,
    setSelectedConsumer,
    selectedGroupRow,
    filteredPending,
    loading,
    error,
    autoRefresh,
    setAutoRefresh,
    refresh,
    rateStats,
  };
}

export type { RedisStreamConsumer, RedisStreamGroup, RedisStreamPendingEntry };
