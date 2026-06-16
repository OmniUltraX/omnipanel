import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { commands } from "../../ipc/bindings";
import { Button } from "../../components/ui/Button";
import { DetailPanelModeToggle } from "../../components/ui/DetailPanelShell";
import { CloseIcon } from "./icons";

interface ContainerStats {
  containerId: string;
  name: string;
  cpuPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number | null;
  memoryPercent: number;
  netRxBytes: number;
  netTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  timestampMs: number;
}

interface DockerStatsPanelProps {
  connectionId: string | null;
  containerId: string | null;
  containerName: string;
  onClose: () => void;
}

function fmtBytes(b: number | null | undefined): string {
  if (b == null) return "-";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtPercent(v: number | null | undefined): string {
  if (v == null) return "-";
  return `${v.toFixed(1)}%`;
}

export function DockerStatsPanel({ connectionId, containerId, containerName, onClose }: DockerStatsPanelProps) {
  const [stats, setStats] = useState<ContainerStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(true);
  const streamIdRef = useRef<string | null>(null);

  useEffect(() => {
    setStats(null);
    setError(null);
    setActive(true);
  }, [connectionId, containerId]);

  useEffect(() => {
    if (!connectionId || !containerId || !active) return;

    let disposed = false;
    const unlistens: UnlistenFn[] = [];

    const stopStream = (streamId: string | null) => {
      if (!streamId) return;
      void commands.dockerStopStatsStream(streamId).catch(() => {});
    };

    const start = async () => {
      try {
        const unlistenStats = await listen<{ streamId: string; stats: ContainerStats }>("docker-stats", (e) => {
          if (disposed) return;
          if (e.payload.streamId === streamIdRef.current) {
            setStats(e.payload.stats);
            setError(null);
          }
        });
        unlistens.push(unlistenStats);

        const unlistenEnd = await listen<{ streamId: string; error?: string }>("docker-stats-end", (e) => {
          if (disposed) return;
          if (e.payload.streamId === streamIdRef.current) {
            if (e.payload.error) setError(e.payload.error);
          }
        });
        unlistens.push(unlistenEnd);

        const r = await commands.dockerStreamStats(connectionId, containerId);
        if (disposed) {
          if (r.status === "ok") stopStream(r.data);
          return;
        }
        if (r.status === "ok") {
          streamIdRef.current = r.data;
        } else {
          setError(r.error.message);
        }
      } catch (e) {
        if (!disposed) setError(String(e));
      }
    };

    void start();

    return () => {
      disposed = true;
      unlistens.forEach((u) => u());
      stopStream(streamIdRef.current);
      streamIdRef.current = null;
    };
  }, [connectionId, containerId, active]);

  return (
    <div className="docker-stats-panel">
      <div className="docker-stats-header">
        <strong className="detail-panel-floating-hide">资源监控 — {containerName}</strong>
        <div className="flex items-center gap-2">
          <DetailPanelModeToggle />
          <label className="text-sm text-muted" style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            实时刷新
          </label>
          <Button variant="icon" className="detail-panel-floating-hide" onClick={onClose} title="关闭">
            <CloseIcon />
          </Button>
        </div>
      </div>
      {error && <div className="docker-stats-error text-sm text-danger">{error}</div>}
      {stats ? (
        <div className="docker-stats-grid">
          <Stat label="CPU" value={fmtPercent(stats.cpuPercent)} highlight={stats.cpuPercent > 80} />
          <Stat label="内存使用" value={fmtBytes(stats.memoryUsageBytes)} />
          <Stat label="内存限额" value={stats.memoryLimitBytes != null ? fmtBytes(stats.memoryLimitBytes) : "无"} />
          <Stat label="内存占比" value={fmtPercent(stats.memoryPercent)} highlight={stats.memoryPercent > 80} />
          <Stat label="网络 RX" value={fmtBytes(stats.netRxBytes)} />
          <Stat label="网络 TX" value={fmtBytes(stats.netTxBytes)} />
          <Stat label="块设备读" value={fmtBytes(stats.blockReadBytes)} />
          <Stat label="块设备写" value={fmtBytes(stats.blockWriteBytes)} />
        </div>
      ) : (
        <div className="docker-stats-waiting">{error ? "无法获取监控数据" : "等待数据…"}</div>
      )}
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="docker-stats-metric">
      <div className="docker-stats-metric-label">{label}</div>
      <div className={`docker-stats-metric-value${highlight ? " text-danger" : ""}`}>{value}</div>
    </div>
  );
}
