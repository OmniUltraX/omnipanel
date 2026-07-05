import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/i18n";
import type { SshProcessInfo, SshProcessPort } from "@/ipc/bindings";
import { formatBytes } from "@/stores/sshStatsStore";
import {
  ALL_PROCESS_COLUMNS,
  useProcessListColumnsStore,
  type ProcessColumnId,
} from "@/stores/processListColumnsStore";
import type { DetailTab } from "@/modules/server/ssh/types";
import { ProcessDetailDrawer } from "./ProcessDetailDrawer";
import { TunnelCreateDialog, type TunnelDraft } from "./TunnelCreateDialog";
import { TextInput } from "@/components/ui/TextInput";

import { metricBarColor } from "@/modules/server/ssh/components/monitoring/monitoringUtils";

function InlineMetricBar({
  value,
  kind,
}: {
  value: number | null | undefined;
  kind: "cpu" | "gpu" | "mem";
}) {
  if (value == null || Number.isNaN(value)) return <>—</>;
  const pct = Math.min(100, Math.max(0, value * 10));
  const color = metricBarColor(value, kind);
  return (
    <div className="mon-inline-bar">
      <div className="mon-inline-bar-track">
        <div
          className="mon-inline-bar-fill"
          style={{
            width: `${pct}%`,
            minWidth: value > 0 ? 3 : 0,
            background: color,
          }}
        />
      </div>
      <span className="mon-inline-bar-val">{value.toFixed(1)}</span>
    </div>
  );
}

type UserFilter = "all" | "root" | "user";
type SortKey = Exclude<keyof SshProcessInfo, "ports">;
const PAGE_SIZE = 50;

const METRIC_SORT_KEYS: SortKey[] = ["cpu", "gpuUsage", "mem", "vsz", "rss"];

type ColumnDef = {
  id: ProcessColumnId;
  sortKey?: SortKey;
  labelKey: string;
  align?: "right";
  colClass: string;
  sortable: boolean;
  render: (p: SshProcessInfo, ctx: ColumnRenderCtx) => React.ReactNode;
};

type ColumnRenderCtx = {
  enableTunnels: boolean;
  variant?: "default" | "monitor";
  t: ReturnType<typeof useI18n>["t"];
  openTunnelDialog: (port: SshProcessPort) => void;
};

function buildColumnDefs(): ColumnDef[] {
  return [
    {
      id: "user",
      sortKey: "user",
      labelKey: "ssh.processList.user",
      colClass: "proc-col-user",
      sortable: true,
      render: (p) => p.user,
    },
    {
      id: "pid",
      sortKey: "pid",
      labelKey: "ssh.processList.pid",
      align: "right",
      colClass: "proc-col-pid",
      sortable: true,
      render: (p) => p.pid,
    },
    {
      id: "ports",
      labelKey: "ssh.processList.ports",
      colClass: "proc-col-ports",
      sortable: false,
      render: (p, ctx) => {
        if ((p.ports ?? []).length === 0) return "—";
        const portNodes = (p.ports ?? []).slice(0, 3).map((port, idx) => {
          const label = `:${port.localPort}`;
          if (!ctx.enableTunnels) {
            return (
              <span
                key={`${port.localPort}-${port.protocol}-${idx}`}
                className="proc-port-badge proc-port-badge--readonly"
                title={`${port.protocol.toUpperCase()} ${port.localAddress}:${port.localPort}`}
              >
                {label}
              </span>
            );
          }
          return (
            <button
              key={`${port.localPort}-${port.protocol}-${idx}`}
              type="button"
              className="proc-port-badge"
              title={ctx.t("ssh.processList.createTunnel")}
              onClick={(e) => {
                e.stopPropagation();
                ctx.openTunnelDialog(port);
              }}
            >
              {label}
            </button>
          );
        });
        return (
          <div className="proc-ports-inner">
            {portNodes}
            {(p.ports ?? []).length > 3 && (
              <span className="proc-port-more">+{(p.ports ?? []).length - 3}</span>
            )}
          </div>
        );
      },
    },
    {
      id: "cpu",
      sortKey: "cpu",
      labelKey: "ssh.processList.cpu",
      align: "right",
      colClass: "proc-col-cpu",
      sortable: true,
      render: (p, ctx) =>
        ctx.variant === "monitor" ? (
          <InlineMetricBar value={p.cpu} kind="cpu" />
        ) : (
          p.cpu?.toFixed(1) ?? "—"
        ),
    },
    {
      id: "gpu",
      sortKey: "gpuUsage",
      labelKey: "ssh.processList.gpu",
      align: "right",
      colClass: "proc-col-gpu",
      sortable: true,
      render: (p, ctx) =>
        ctx.variant === "monitor" ? (
          <InlineMetricBar value={p.gpuUsage} kind="gpu" />
        ) : (
          p.gpuUsage != null ? p.gpuUsage.toFixed(1) : "—"
        ),
    },
    {
      id: "mem",
      sortKey: "mem",
      labelKey: "ssh.processList.mem",
      align: "right",
      colClass: "proc-col-mem",
      sortable: true,
      render: (p, ctx) =>
        ctx.variant === "monitor" ? (
          <InlineMetricBar value={p.mem} kind="mem" />
        ) : (
          p.mem?.toFixed(1) ?? "—"
        ),
    },
    {
      id: "vsz",
      sortKey: "vsz",
      labelKey: "ssh.processList.vsz",
      align: "right",
      colClass: "proc-col-vsz",
      sortable: true,
      render: (p) => (p.vsz != null ? formatBytes(p.vsz) : "—"),
    },
    {
      id: "rss",
      sortKey: "rss",
      labelKey: "ssh.processList.rss",
      align: "right",
      colClass: "proc-col-rss",
      sortable: true,
      render: (p) => (p.rss != null ? formatBytes(p.rss * 1024) : "—"),
    },
    {
      id: "stat",
      sortKey: "stat",
      labelKey: "ssh.processList.stat",
      colClass: "proc-col-stat",
      sortable: true,
      render: (p) => p.stat,
    },
    {
      id: "start",
      sortKey: "start",
      labelKey: "ssh.processList.start",
      colClass: "proc-col-start",
      sortable: true,
      render: (p) => p.start,
    },
    {
      id: "time",
      sortKey: "time",
      labelKey: "ssh.processList.time",
      colClass: "proc-col-time",
      sortable: true,
      render: (p) => p.time,
    },
    {
      id: "command",
      sortKey: "command",
      labelKey: "ssh.processList.command",
      colClass: "proc-col-cmd",
      sortable: true,
      render: (p) => p.command,
    },
  ];
}

const COLUMN_LABEL_KEYS: Record<ProcessColumnId, string> = {
  user: "ssh.processList.user",
  pid: "ssh.processList.pid",
  ports: "ssh.processList.ports",
  cpu: "ssh.processList.cpu",
  gpu: "ssh.processList.gpu",
  mem: "ssh.processList.mem",
  vsz: "ssh.processList.vsz",
  rss: "ssh.processList.rss",
  stat: "ssh.processList.stat",
  start: "ssh.processList.start",
  time: "ssh.processList.time",
  command: "ssh.processList.command",
};

export type ProcessListPanelProps = {
  resourceId: string | null;
  processes: SshProcessInfo[];
  loading: boolean;
  refreshing: boolean;
  updatedAt: number | null;
  error?: string | null;
  onRefresh: () => void;
  /** @deprecated terminal/sftp Tab 已移除，此 prop 已无效，保留仅为兼容 */
  setDetailTab?: (tab: DetailTab) => void;
  enableTunnels?: boolean;
  variant?: "default" | "monitor";
};

export function ProcessListPanel({
  resourceId,
  processes,
  loading,
  refreshing: _refreshing,
  updatedAt,
  error,
  onRefresh,
  setDetailTab: _setDetailTab,
  enableTunnels = true,
  variant = "default",
}: ProcessListPanelProps) {
  const { t } = useI18n();
  const [page, setPage] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>("cpu");
  const [sortDir, setSortDir] = useState<-1 | 1>(-1);
  const [query, setQuery] = useState("");
  const [userFilter, setUserFilter] = useState<UserFilter>("all");
  const [tunnelDraft, setTunnelDraft] = useState<TunnelDraft | null>(null);
  const [selectedProcess, setSelectedProcess] = useState<SshProcessInfo | null>(null);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const columnsRef = useRef<HTMLDivElement>(null);

  const visibleColumnIds = useProcessListColumnsStore((s) => s.visibleColumns);
  const toggleColumn = useProcessListColumnsStore((s) => s.toggleColumn);
  const resetColumns = useProcessListColumnsStore((s) => s.resetColumns);

  const allColumns = useMemo(() => buildColumnDefs(), []);
  const visibleColumns = useMemo(
    () => allColumns.filter((c) => visibleColumnIds.includes(c.id)),
    [allColumns, visibleColumnIds],
  );

  useEffect(() => {
    const col = allColumns.find((c) => c.sortKey === sortKey);
    if (col && !visibleColumnIds.includes(col.id)) {
      const fallback =
        METRIC_SORT_KEYS.map((k) => allColumns.find((c) => c.sortKey === k))
          .find((c) => c && visibleColumnIds.includes(c.id)) ??
        allColumns.find((c) => visibleColumnIds.includes(c.id) && c.sortKey);
      if (fallback?.sortKey) {
        setSortKey(fallback.sortKey);
        setSortDir(fallback.sortKey === "cpu" || fallback.sortKey === "gpuUsage" || fallback.sortKey === "mem" ? -1 : 1);
      }
    }
  }, [allColumns, sortKey, visibleColumnIds]);

  useEffect(() => {
    if (!columnsOpen) return;
    function onDocClick(e: MouseEvent) {
      if (columnsRef.current && !columnsRef.current.contains(e.target as Node)) {
        setColumnsOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [columnsOpen]);

  function openTunnelDialog(port: SshProcessPort) {
    setSelectedProcess(null);
    setTunnelDraft({
      remotePort: port.localPort,
      localPort: String(port.localPort),
      remoteHost: port.localAddress === "*" || port.localAddress === "::" ? "127.0.0.1" : port.localAddress,
      tunnelType: "local",
    });
  }

  const renderCtx: ColumnRenderCtx = {
    enableTunnels,
    variant,
    t,
    openTunnelDialog,
  };

  const filtered = processes.filter((p) => {
    if (userFilter === "root" && p.user !== "root") return false;
    if (userFilter === "user" && p.user === "root") return false;
    if (!query.trim()) return true;
    const q = query.trim().toLowerCase();
    const portHit = (p.ports ?? []).some((port) =>
      String(port.localPort).includes(q) ||
      (port.localAddress ?? "").toLowerCase().includes(q),
    );
    return (
      String(p.pid).includes(q) ||
      (p.user ?? "").toLowerCase().includes(q) ||
      (p.command ?? "").toLowerCase().includes(q) ||
      portHit
    );
  });

  const sorted = [...filtered].sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    if (sortKey === "gpuUsage") {
      const an = av == null ? -1 : Number(av);
      const bn = bv == null ? -1 : Number(bv);
      return sortDir * (an - bn);
    }
    if (typeof av === "number" && typeof bv === "number") return sortDir * (av - bv);
    const avs = av == null ? "" : String(av);
    const bvs = bv == null ? "" : String(bv);
    return sortDir * avs.localeCompare(bvs);
  });

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const paged = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 1 ? -1 : 1));
    } else {
      setSortKey(key);
      setSortDir(key === "cpu" || key === "gpuUsage" || key === "mem" ? -1 : 1);
    }
    setPage(0);
  }

  function SortIndicator({ col }: { col: SortKey }) {
    if (col !== sortKey) return <span className="proc-sort-arrow">↕</span>;
    return <span className="proc-sort-arrow proc-sort-active">{sortDir === -1 ? "↓" : "↑"}</span>;
  }

  const updatedLabel =
    updatedAt != null ? new Date(updatedAt).toLocaleTimeString() : null;

  return (
    <div className={`proc-panel${variant === "monitor" ? " mon-process-section" : ""}`}>
      <div className={variant === "monitor" ? "mon-process-head proc-header" : "proc-header"}>
        {variant === "monitor" ? (
          <h3>{t("ssh.processList.title")}</h3>
        ) : (
          <span className="proc-title">{t("ssh.processList.title")}</span>
        )}
        <span className="proc-count mon-process-count">
          {t("ssh.processList.total", { count: filtered.length })}
        </span>
        {updatedLabel && (
          <span className="proc-updated mon-process-updated">
            {t("ssh.processList.updatedAt", { time: updatedLabel })}
          </span>
        )}
        <div className={variant === "monitor" ? "mon-process-tools proc-header-actions" : "proc-header-actions"}>
          <TextInput
            copyable={false}
            size="sm"
            className={`input input-sm proc-search${variant === "monitor" ? " mon-process-search" : ""}`}
            placeholder={t("ssh.processList.search")}
            value={query}
            onChange={(value) => {
              setQuery(value);
              setPage(0);
            }}
          />
          {variant === "monitor" && (
            <select
              className="mon-filter-select"
              value={userFilter}
              onChange={(e) => {
                setUserFilter(e.target.value as UserFilter);
                setPage(0);
              }}
            >
              <option value="all">{t("ssh.processList.filterAll")}</option>
              <option value="root">root</option>
              <option value="user">{t("ssh.processList.filterUser")}</option>
            </select>
          )}
          <div className="proc-columns-picker" ref={columnsRef}>
            <button
              type="button"
              className="proc-columns-btn"
              onClick={() => setColumnsOpen((o) => !o)}
              aria-expanded={columnsOpen}
              title={t("ssh.processList.columns")}
            >
              {t("ssh.processList.columns")}
            </button>
            {columnsOpen && (
              <div className="proc-columns-menu" role="menu">
                {ALL_PROCESS_COLUMNS.map((id) => {
                  const checked = visibleColumnIds.includes(id);
                  const isLastRequired =
                    (id === "pid" || id === "command") &&
                    checked &&
                    visibleColumnIds.filter((c) => c === "pid" || c === "command").length === 1;
                  return (
                    <label key={id} className="proc-columns-item">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={isLastRequired}
                        onChange={() => toggleColumn(id)}
                      />
                      <span>{t(COLUMN_LABEL_KEYS[id])}</span>
                    </label>
                  );
                })}
                <button type="button" className="proc-columns-reset" onClick={resetColumns}>
                  {t("ssh.processList.columnsReset")}
                </button>
              </div>
            )}
          </div>
          <button className="proc-refresh" onClick={onRefresh} disabled={loading} title={loading ? t("ssh.overview.refreshing") : undefined}>
            {loading ? "⟳" : "↻"}
          </button>
        </div>
      </div>
      {error && !loading ? (
        <div className="proc-empty proc-error">{error}</div>
      ) : null}
      {paged.length === 0 && !loading && !error && (
        <div className="proc-empty">{t("ssh.processList.empty")}</div>
      )}
      <div className="proc-table-wrap">
        <table className="proc-table">
          <colgroup>
            {visibleColumns.map((c) => (
              <col key={c.id} className={c.colClass} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {visibleColumns.map((c) => (
                <th
                  key={c.id}
                  className={[
                    c.align === "right" ? "proc-cell-right" : undefined,
                    c.sortable && c.sortKey === sortKey ? "proc-sorted sorted" : undefined,
                    c.id === "user" ? "proc-col-user col-user" : undefined,
                    c.id === "pid" ? "proc-col-pid col-pid" : undefined,
                  ].filter(Boolean).join(" ") || undefined}
                  onClick={c.sortable && c.sortKey ? () => handleSort(c.sortKey!) : undefined}
                >
                  {t(c.labelKey)}
                  {c.sortable && c.sortKey ? <> <SortIndicator col={c.sortKey} /></> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paged.map((p, rowIndex) => (
              <tr
                key={`${p.pid}-${p.user}-${rowIndex}`}
                className={[
                  "proc-row-clickable",
                  selectedProcess?.pid === p.pid ? "proc-row-selected selected" : "",
                ].filter(Boolean).join(" ")}
                onClick={() => setSelectedProcess(p)}
              >
                {visibleColumns.map((c) => (
                  <td
                    key={c.id}
                    className={[
                      c.align === "right" ? "proc-cell-right" : undefined,
                      c.id === "command" ? "proc-cell-cmd col-cmd" : undefined,
                      c.id === "ports" ? "proc-cell-ports" : undefined,
                      c.id === "start" || c.id === "time" || c.id === "stat"
                        ? "proc-cell-compact"
                        : undefined,
                    ].filter(Boolean).join(" ") || undefined}
                    title={
                      c.id === "command"
                        ? p.command
                        : c.id === "start" || c.id === "time" || c.id === "stat"
                          ? String(c.render(p, renderCtx) ?? "")
                          : undefined
                    }
                  >
                    {c.render(p, renderCtx)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="proc-pager">
          <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>‹</button>
          <span>{page + 1} / {totalPages}</span>
          <button disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>›</button>
        </div>
      )}
      <ProcessDetailDrawer
        resourceId={resourceId}
        process={selectedProcess}
        onClose={() => setSelectedProcess(null)}
        onKilled={onRefresh}
        onPortClick={openTunnelDialog}
      />
      <TunnelCreateDialog
        open={enableTunnels && tunnelDraft != null}
        resourceId={resourceId}
        draft={tunnelDraft}
        onClose={() => setTunnelDraft(null)}
      />
    </div>
  );
}
