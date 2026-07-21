import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useShallow } from "zustand/react/shallow";
import { MultiSelect } from "../../../components/ui/form/MultiSelect";
import { CodeEditor } from "../../../components/ui/CodeEditor";
import { useI18n } from "../../../i18n";
import { appConfirm } from "../../../lib/appConfirm";
import { useConnectionStore } from "../../../stores/connectionStore";
import { listDatabases, listTables, type DbConnectionConfig } from "../api";
import {
  MY2SQL_DOWNLOAD_URL,
  MY2SQL_REMOTE_INSTALL_PATH,
  executeFlashbackSql,
  assertFlashbackCoversSparseDeletes,
  buildFlashbackSqlFromEvents,
  canBuildFlashbackLocally,
  filterRollbackSqlBySelection,
  generateFlashbackSql,
  getBinlogFileTimes,
  installRemoteMy2sql,
  listBinaryLogs,
  loadBinlogTimelineChunked,
  resolveFlashbackTool,
  resolveMysqlbinlogPath,
  resolveSelectionRange,
  isSparseDeleteForward,
  SPARSE_DELETE_FLASHBACK_HINT,
  INCOMPLETE_UPDATE_FLASHBACK_HINT,
  type BinlogFileInfo,
  type BinlogTimelineEvent,
  type FlashbackToolResolution,
} from "../mysqlBinlog";

/** 时间线行高（含分隔），配合虚拟滚动固定估算。 */
const BINLOG_TIMELINE_ROW_HEIGHT = 44;
const BINLOG_TIMELINE_VIRTUALIZE_THRESHOLD = 40;
const SYSTEM_DB_SKIP = new Set(["information_schema", "performance_schema", "mysql", "sys"]);

type BinlogSortKey = "kind" | "time" | "table" | "pos" | "summary";

interface DatabaseBinlogPanelProps {
  connection: DbConnectionConfig;
  sshConnectionId: string;
  deploymentKind?: "host" | "docker";
  containerId?: string;
  logBinBasename?: string;
  binlogFormat?: string;
  binlogRowImage?: string;
  flashbackCapable?: boolean;
  active: boolean;
}

function toMysqlDatetime(localValue: string): string | undefined {
  const trimmed = localValue.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.replace("T", " ");
  return normalized.length === 16 ? `${normalized}:00` : normalized;
}

function toDatetimeLocalValue(value: Date): string {
  const adjusted = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return adjusted.toISOString().slice(0, 16);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DatabaseBinlogPanel({
  connection,
  sshConnectionId,
  deploymentKind,
  containerId,
  logBinBasename,
  binlogFormat,
  binlogRowImage,
  flashbackCapable,
  active,
}: DatabaseBinlogPanelProps) {
  const { t } = useI18n();
  const sshConnections = useConnectionStore(
    useShallow((state) => state.connections.filter((c) => c.kind === "ssh")),
  );

  const [files, setFiles] = useState<BinlogFileInfo[]>([]);
  const [selectedFile, setSelectedFile] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [selectedDatabases, setSelectedDatabases] = useState<string[]>([]);
  const [selectedTables, setSelectedTables] = useState<string[]>([]);
  const [kindFilter, setKindFilter] = useState<string[]>([]);
  const [keyword, setKeyword] = useState("");
  const [sortKey, setSortKey] = useState<BinlogSortKey>("time");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [databaseOptions, setDatabaseOptions] = useState<string[]>([]);
  const [tableOptions, setTableOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [backgroundLoading, setBackgroundLoading] = useState(false);
  const [filesRefreshing, setFilesRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<BinlogTimelineEvent[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [tool, setTool] = useState<FlashbackToolResolution | null>(null);
  const [installing, setInstalling] = useState(false);
  const [flashbackSql, setFlashbackSql] = useState("");
  const [generating, setGenerating] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const loadGenRef = useRef(0);

  const metaLine = useMemo(() => {
    const parts = [
      binlogFormat ? `format=${binlogFormat}` : null,
      binlogRowImage ? `row_image=${binlogRowImage}` : null,
      flashbackCapable === false ? t("database.binlog.flashbackNotCapable") : null,
    ].filter(Boolean);
    return parts.join(" · ");
  }, [binlogFormat, binlogRowImage, flashbackCapable, t]);

  const visibleEvents = useMemo(() => {
    const allowedKinds = kindFilter.length > 0 ? new Set(kindFilter) : null;
    const kw = keyword.trim().toLowerCase();
    let list = events;
    if (allowedKinds) {
      list = list.filter((ev) => allowedKinds.has(ev.kind));
    }
    if (kw) {
      list = list.filter((ev) => {
        const haystack = [
          ev.kind,
          ev.time,
          ev.database,
          ev.table,
          `${ev.database}.${ev.table}`,
          String(ev.startPos),
          String(ev.stopPos),
          ev.summary,
          ev.sql,
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(kw);
      });
    }
    const dir = sortDir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "kind":
          cmp = a.kind.localeCompare(b.kind);
          break;
        case "time":
          cmp = a.time.localeCompare(b.time);
          if (cmp === 0) cmp = a.startPos - b.startPos;
          break;
        case "table":
          cmp = `${a.database}.${a.table}`.localeCompare(`${b.database}.${b.table}`);
          break;
        case "pos":
          cmp =
            a.binlogFile !== b.binlogFile
              ? a.binlogFile.localeCompare(b.binlogFile)
              : a.startPos - b.startPos;
          break;
        case "summary":
          cmp = a.summary.localeCompare(b.summary);
          break;
        default:
          cmp = 0;
      }
      return cmp * dir;
    });
  }, [events, kindFilter, keyword, sortKey, sortDir]);

  const toggleSort = useCallback(
    (key: BinlogSortKey) => {
      if (sortKey === key) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        return;
      }
      setSortKey(key);
      setSortDir(key === "time" || key === "pos" ? "desc" : "asc");
    },
    [sortKey],
  );

  const stopLoading = useCallback(() => {
    loadGenRef.current += 1;
    setLoading(false);
    setBackgroundLoading(false);
    setStatusMsg((prev) =>
      prev ? `${prev} · ${t("database.binlog.loadStopped")}` : t("database.binlog.loadStopped"),
    );
  }, [t]);

  const selectedEvents = useMemo(
    () => visibleEvents.filter((ev) => selectedIds.has(ev.id)),
    [visibleEvents, selectedIds],
  );

  const selectionRange = useMemo(
    () => resolveSelectionRange(selectedEvents),
    [selectedEvents],
  );

  const forwardSql = useMemo(() => {
    if (selectedEvents.length === 1) return selectedEvents[0].sql;
    if (selectedEvents.length > 1) return selectedEvents.map((e) => e.sql).join(";\n\n");
    return "";
  }, [selectedEvents]);

  const sqlHighlightQuery = keyword.trim();

  const my2sqlDatabases = useMemo(
    () => (selectedDatabases.length > 0 ? selectedDatabases.join(",") : undefined),
    [selectedDatabases],
  );

  const my2sqlTables = useMemo(() => {
    if (selectedTables.length === 0) return undefined;
    const names = selectedTables.map((value) => {
      const idx = value.indexOf(".");
      return idx >= 0 ? value.slice(idx + 1) : value;
    });
    return [...new Set(names)].join(",");
  }, [selectedTables]);

  const databaseSelectOptions = useMemo(
    () => databaseOptions.map((name) => ({ value: name, label: name })),
    [databaseOptions],
  );

  const tableSelectOptions = useMemo(
    () => tableOptions.map((name) => ({ value: name, label: name })),
    [tableOptions],
  );

  const kindSelectOptions = useMemo(
    () => [
      { value: "INSERT", label: t("database.binlog.kindInsert") },
      { value: "UPDATE", label: t("database.binlog.kindUpdate") },
      { value: "DELETE", label: t("database.binlog.kindDelete") },
    ],
    [t],
  );

  const refreshFiles = useCallback(async () => {
    setFilesRefreshing(true);
    setError(null);
    try {
      const list = await listBinaryLogs(connection);
      setFiles(list);
      setSelectedFile((prev) => {
        if (prev && list.some((f) => f.name === prev)) return prev;
        return list.length > 0 ? list[list.length - 1].name : "";
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFilesRefreshing(false);
    }
  }, [connection]);

  const refreshTool = useCallback(async (): Promise<FlashbackToolResolution> => {
    try {
      const resolved = await resolveFlashbackTool(sshConnectionId);
      setTool(resolved);
      return resolved;
    } catch (e) {
      const unavailable: FlashbackToolResolution = {
        status: "unavailable",
        reason: e instanceof Error ? e.message : String(e),
      };
      setTool(unavailable);
      return unavailable;
    }
  }, [sshConnectionId]);

  useEffect(() => {
    if (!active) return;
    void refreshFiles();
    void refreshTool();
  }, [active, refreshFiles, refreshTool]);

  useEffect(() => {
    return () => {
      loadGenRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void listDatabases(connection)
      .then((names) => {
        if (cancelled) return;
        setDatabaseOptions(names.filter((name) => !SYSTEM_DB_SKIP.has(name.toLowerCase())));
      })
      .catch(() => {
        if (!cancelled) setDatabaseOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [active, connection]);

  useEffect(() => {
    if (!active) return;
    if (selectedDatabases.length === 0) {
      setTableOptions([]);
      setSelectedTables([]);
      return;
    }
    let cancelled = false;
    void Promise.all(
      selectedDatabases.map(async (db) => {
        const tables = await listTables(connection, db);
        return tables.map((table) => `${db}.${table}`);
      }),
    )
      .then((groups) => {
        if (cancelled) return;
        const next = groups.flat();
        setTableOptions(next);
        setSelectedTables((prev) => prev.filter((value) => next.includes(value)));
      })
      .catch(() => {
        if (!cancelled) {
          setTableOptions([]);
          setSelectedTables([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [active, connection, selectedDatabases]);

  useEffect(() => {
    if (!active || !selectedFile) return;

    let cancelled = false;
    const logFilePath = resolveMysqlbinlogPath(logBinBasename, selectedFile);
    void getBinlogFileTimes({
      sshConnectionId,
      logFilePath,
      deploymentKind,
      containerId,
    })
      .then(({ createdAt, modifiedAt }) => {
        if (cancelled) return;
        const start = createdAt ?? modifiedAt;
        if (start) setDateFrom(toDatetimeLocalValue(start));
        if (modifiedAt) setDateTo(toDatetimeLocalValue(modifiedAt));
      })
      .catch(() => {
        // 部分文件系统不支持创建时间；不影响用户手动填写。
      });

    return () => {
      cancelled = true;
    };
  }, [active, selectedFile, logBinBasename, sshConnectionId, deploymentKind, containerId]);

  const loadTimeline = useCallback(async (readyTool?: Extract<FlashbackToolResolution, { status: "ready" }>) => {
    if (!selectedFile) return;
    const currentTool = readyTool ?? tool;
    if (!currentTool || currentTool.status !== "ready") {
      setError(t("database.binlog.generateNeedTool"));
      return;
    }
    if (currentTool.kind !== "my2sql") {
      setError(t("database.binlog.timelineNeedMy2sql"));
      return;
    }

    const gen = ++loadGenRef.current;
    setLoading(true);
    setBackgroundLoading(false);
    setError(null);
    setStatusMsg(t("database.binlog.loading"));
    setFlashbackSql("");
    setSelectedIds(new Set());
    setAnchorId(null);
    setEvents([]);

    try {
      await loadBinlogTimelineChunked({
        connection,
        sshConnectionId,
        sshConnections,
        tool: currentTool,
        startFile: selectedFile,
        startDatetime: toMysqlDatetime(dateFrom),
        stopDatetime: toMysqlDatetime(dateTo),
        databases: my2sqlDatabases,
        tables: my2sqlTables,
        logBinBasename,
        preferReplMode: deploymentKind === "docker",
        newestFirst: true,
        shouldCancel: () => loadGenRef.current !== gen,
        onChunk: ({ merged, chunkIndex, chunkTotal, done }) => {
          if (loadGenRef.current !== gen) return;
          setEvents(merged);
          if (chunkIndex === 1) {
            setLoading(false);
            setBackgroundLoading(!done);
          }
          if (done) {
            setBackgroundLoading(false);
            setStatusMsg(
              merged.length === 0
                ? t("database.binlog.emptyTimeline")
                : t("database.binlog.timelineLoaded", { count: merged.length }),
            );
          } else {
            setBackgroundLoading(true);
            setStatusMsg(
              t("database.binlog.timelineLoadingProgress", {
                count: merged.length,
                current: chunkIndex,
                total: chunkTotal,
              }),
            );
          }
        },
      });
      if (loadGenRef.current !== gen) return;
      setLoading(false);
      setBackgroundLoading(false);
    } catch (e) {
      if (loadGenRef.current !== gen) return;
      setEvents([]);
      setError(e instanceof Error ? e.message : String(e));
      setStatusMsg(null);
      setLoading(false);
      setBackgroundLoading(false);
    }
  }, [
    selectedFile,
    tool,
    connection,
    sshConnectionId,
    sshConnections,
    dateFrom,
    dateTo,
    my2sqlDatabases,
    my2sqlTables,
    logBinBasename,
    deploymentKind,
    t,
  ]);

  const confirmAndInstallMy2sql = useCallback(async () => {
    const message = [
      t("database.binlog.installConfirmBody"),
      "",
      `${t("database.binlog.installPath")}: ${MY2SQL_REMOTE_INSTALL_PATH}`,
      `${t("database.binlog.installUrl")}: ${MY2SQL_DOWNLOAD_URL}`,
      tool?.status === "need_install"
        ? `${t("database.binlog.installArch")}: ${tool.remoteOs ?? "?"} / ${tool.remoteArch ?? "?"}`
        : null,
      "",
      t("database.binlog.installRisk"),
    ]
      .filter((line) => line !== null)
      .join("\n");

    const ok = await appConfirm(message, t("database.binlog.installConfirmTitle"), {
      kind: "warning",
      confirmLabel: t("database.binlog.installConfirmOk"),
    });
    if (!ok) return;

    setInstalling(true);
    setError(null);
    setStatusMsg(t("database.binlog.installing"));
    try {
      const path = await installRemoteMy2sql(sshConnectionId);
      setStatusMsg(t("database.binlog.installSuccess", { path }));
      const resolved = await refreshTool();
      if (resolved.status === "ready" && selectedFile) {
        await loadTimeline(resolved);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatusMsg(null);
    } finally {
      setInstalling(false);
    }
  }, [sshConnectionId, tool, refreshTool, selectedFile, loadTimeline, t]);

  const toggleSelect = useCallback(
    (eventId: string, opts: { shiftKey: boolean; ctrlKey: boolean }) => {
      setSelectedIds((prev) => {
        // Shift：连续范围多选
        if (opts.shiftKey && anchorId) {
          const startIdx = visibleEvents.findIndex((e) => e.id === anchorId);
          const endIdx = visibleEvents.findIndex((e) => e.id === eventId);
          if (startIdx >= 0 && endIdx >= 0) {
            const next = new Set(prev);
            const [from, to] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
            for (let i = from; i <= to; i++) {
              next.add(visibleEvents[i].id);
            }
            return next;
          }
        }
        // Ctrl/Cmd：切换多选
        if (opts.ctrlKey) {
          const next = new Set(prev);
          if (next.has(eventId)) next.delete(eventId);
          else next.add(eventId);
          return next;
        }
        // 普通点击：单选
        return new Set([eventId]);
      });
      setAnchorId(eventId);
      setFlashbackSql("");
    },
    [anchorId, visibleEvents],
  );

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setAnchorId(null);
    setFlashbackSql("");
  }, []);

  const runGenerateFlashback = useCallback(async () => {
    if (!selectedFile) return;
    if (flashbackCapable === false) {
      setError(t("database.binlog.flashbackRequireRowFull"));
      return;
    }
    if (!tool || tool.status !== "ready") {
      setError(t("database.binlog.generateNeedTool"));
      return;
    }
    if (selectedEvents.length === 0 && !toMysqlDatetime(dateFrom) && !toMysqlDatetime(dateTo)) {
      setError(t("database.binlog.selectRangeHint"));
      return;
    }

    setGenerating(true);
    setError(null);
    setStatusMsg(t("database.binlog.generating"));
    try {
      if (selectedEvents.length > 0) {
        // 1) 正向 SQL 已含完整行镜像 → 本地反转（INSERT / 完整 DELETE / 完整 UPDATE）
        if (canBuildFlashbackLocally(selectedEvents)) {
          const sql = buildFlashbackSqlFromEvents(selectedEvents);
          setFlashbackSql(sql);
          setStatusMsg(
            t("database.binlog.generateSuccessRange", {
              count: selectedEvents.length,
            }),
          );
          return;
        }

        // 2) 稀疏 DELETE：binlog 本身无其他列，不必再跑 my2sql
        const allSparseDelete = selectedEvents.every(
          (ev) => ev.kind === "DELETE" && isSparseDeleteForward(ev.sql),
        );
        if (allSparseDelete) {
          const rowHint = binlogRowImage
            ? `（当前实例 binlog_row_image=${binlogRowImage}；若事件发生时不是 FULL，则无法补全）`
            : "";
          throw new Error(`${SPARSE_DELETE_FLASHBACK_HINT}${rowHint}`);
        }

        // 3) 其余：尝试 my2sql rollback（时间窗，不用事件 pos）
        const range = selectionRange;
        if (!range?.startFile) {
          throw new Error(t("database.binlog.selectRangeHint"));
        }
        const selDbs = [
          ...new Set(selectedEvents.map((e) => e.database).filter(Boolean)),
        ].join(",");
        const selTables = [
          ...new Set(selectedEvents.map((e) => e.table).filter(Boolean)),
        ].join(",");
        let raw: string;
        try {
          raw = await generateFlashbackSql({
            connection,
            sshConnectionId,
            sshConnections,
            tool,
            startFile: range.startFile,
            stopFile: range.stopFile,
            startDatetime: range.startDatetime,
            stopDatetime: range.stopDatetime,
            databases: selDbs || my2sqlDatabases,
            tables: selTables || my2sqlTables,
            logBinBasename,
            preferReplMode: deploymentKind === "docker",
            addExtraInfo: true,
          });
        } catch (remoteErr) {
          if (selectedEvents.some((ev) => ev.kind === "DELETE" && isSparseDeleteForward(ev.sql))) {
            const rowHint = binlogRowImage
              ? `（当前实例 binlog_row_image=${binlogRowImage}）`
              : "";
            throw new Error(`${SPARSE_DELETE_FLASHBACK_HINT}${rowHint}`);
          }
          if (selectedEvents.some((ev) => ev.kind === "UPDATE")) {
            throw new Error(
              `${INCOMPLETE_UPDATE_FLASHBACK_HINT}\n${remoteErr instanceof Error ? remoteErr.message : String(remoteErr)}`,
            );
          }
          throw remoteErr;
        }
        const sql = filterRollbackSqlBySelection(raw, selectedEvents);
        assertFlashbackCoversSparseDeletes(sql, selectedEvents);
        setFlashbackSql(sql);
        setStatusMsg(
          t("database.binlog.generateSuccessRange", {
            count: selectedEvents.length,
          }),
        );
        return;
      }

      const raw = await generateFlashbackSql({
        connection,
        sshConnectionId,
        sshConnections,
        tool,
        startFile: selectedFile,
        startDatetime: toMysqlDatetime(dateFrom),
        stopDatetime: toMysqlDatetime(dateTo),
        databases: my2sqlDatabases,
        tables: my2sqlTables,
        logBinBasename,
        preferReplMode: deploymentKind === "docker",
      });
      setFlashbackSql(raw);
      setStatusMsg(
        t("database.binlog.generateSuccessRange", {
          count: visibleEvents.length,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setFlashbackSql("");
      setStatusMsg(null);
    } finally {
      setGenerating(false);
    }
  }, [
    selectedFile,
    flashbackCapable,
    tool,
    selectedEvents,
    selectionRange,
    connection,
    sshConnectionId,
    sshConnections,
    dateFrom,
    dateTo,
    my2sqlDatabases,
    my2sqlTables,
    logBinBasename,
    deploymentKind,
    binlogRowImage,
    visibleEvents.length,
    t,
  ]);

  const runExecuteFlashback = useCallback(async () => {
    if (!flashbackSql.trim()) return;
    const ok = await appConfirm(
      t("database.binlog.executeConfirmBody"),
      t("database.binlog.executeConfirmTitle"),
      { kind: "warning", confirmLabel: t("database.binlog.executeConfirmOk") },
    );
    if (!ok) return;

    setExecuting(true);
    setError(null);
    try {
      const result = await executeFlashbackSql(connection, flashbackSql);
      if (result.errors.length > 0) {
        setStatusMsg(
          t("database.binlog.executePartial", {
            ok: result.statements,
            fail: result.errors.length,
          }),
        );
        setError(result.errors.slice(0, 3).join("\n"));
      } else {
        setStatusMsg(t("database.binlog.executeSuccess", { count: result.statements }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExecuting(false);
    }
  }, [flashbackSql, connection, t]);

  const toolLabel = useMemo(() => {
    if (!tool) return t("database.binlog.toolChecking");
    if (tool.status === "ready") {
      return tool.kind === "my2sql"
        ? t("database.binlog.toolMy2sql", { path: tool.command })
        : t("database.binlog.toolBinlog2sql", { path: tool.command });
    }
    if (tool.status === "need_install") return t("database.binlog.toolNeedInstall");
    return t("database.binlog.toolUnavailable", { reason: tool.reason });
  }, [tool, t]);

  /** 无 my2sql 时只保留唯一安装入口（含仅有 binlog2sql / 探测失败）。 */
  const needInstall =
    tool != null &&
    (tool.status === "need_install" ||
      tool.status === "unavailable" ||
      (tool.status === "ready" && tool.kind !== "my2sql"));
  const canLoad = Boolean(selectedFile && tool?.status === "ready" && tool.kind === "my2sql");
  const canGenerate =
    Boolean(tool?.status === "ready") &&
    Boolean(selectedFile) &&
    (selectedEvents.length > 0 || Boolean(toMysqlDatetime(dateFrom) || toMysqlDatetime(dateTo)));

  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const eventsRef = useRef(visibleEvents);
  eventsRef.current = visibleEvents;
  const useTimelineVirtual = visibleEvents.length > BINLOG_TIMELINE_VIRTUALIZE_THRESHOLD;
  const timelineVirtualizer = useVirtualizer({
    count: useTimelineVirtual ? visibleEvents.length : 0,
    getScrollElement: () => (useTimelineVirtual ? timelineScrollRef.current : null),
    estimateSize: () => BINLOG_TIMELINE_ROW_HEIGHT,
    getItemKey: (index) => eventsRef.current[index]?.id ?? index,
    overscan: 12,
    useFlushSync: false,
  });

  const renderTimelineRow = (ev: BinlogTimelineEvent) => {
    const selected = selectedIds.has(ev.id);
    return (
      <button
        type="button"
        className={`binlog-event-row${selected ? " is-selected" : ""}`}
        onClick={(e) =>
          toggleSelect(ev.id, {
            shiftKey: e.shiftKey,
            ctrlKey: e.ctrlKey || e.metaKey,
          })
        }
        title={ev.summary}
      >
        <span className={`binlog-event-row__kind binlog-event-row__kind--${ev.kind.toLowerCase()}`}>
          {ev.kind}
        </span>
        <span className="binlog-event-row__time">{ev.time || "—"}</span>
        <span className="binlog-event-row__table">
          {ev.database}.{ev.table}
        </span>
        <span className="binlog-event-row__pos">
          @{ev.startPos}
        </span>
        <span className="binlog-event-row__summary">{ev.summary}</span>
      </button>
    );
  };

  return (
    <div className="db-binlog-panel">
      <div className="db-binlog-panel__toolbar">
        <span className="db-binlog-panel__title">{t("database.binlog.timelineTitle")}</span>
        <span className="db-binlog-panel__meta">{metaLine}</span>
        <span className="db-binlog-panel__meta">{toolLabel}</span>
      </div>

      <div className="db-binlog-panel__filters">
        <label className="db-binlog-panel__filter-field">
          <span className="db-binlog-panel__filter-label">{t("database.binlog.fileLabel")}</span>
          <select
            className="db-binlog-panel__filter-input"
            value={selectedFile}
            onChange={(e) => setSelectedFile(e.target.value)}
          >
            {files.length === 0 ? (
              <option value="">{t("database.binlog.noFiles")}</option>
            ) : (
              files.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name} ({formatSize(f.size)})
                </option>
              ))
            )}
          </select>
        </label>
        <label className="db-binlog-panel__filter-field">
          <span className="db-binlog-panel__filter-label">{t("database.binlog.filterDateFrom")}</span>
          <input
            type="datetime-local"
            className="db-binlog-panel__filter-input db-binlog-panel__filter-input--datetime"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
        </label>
        <label className="db-binlog-panel__filter-field">
          <span className="db-binlog-panel__filter-label">{t("database.binlog.filterDateTo")}</span>
          <input
            type="datetime-local"
            className="db-binlog-panel__filter-input db-binlog-panel__filter-input--datetime"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </label>
        <label className="db-binlog-panel__filter-field db-binlog-panel__filter-field--select">
          <span className="db-binlog-panel__filter-label">{t("database.binlog.filterDatabase")}</span>
          <MultiSelect
            size="sm"
            className="db-binlog-panel__multi"
            values={selectedDatabases}
            onChange={setSelectedDatabases}
            options={databaseSelectOptions}
            emptyMeansAll={false}
            searchable
            panelMinWidth={240}
            searchPlaceholder={t("database.binlog.filterSearch")}
            placeholder={t("database.binlog.filterDatabaseAll")}
            formatDisplayLabel={(labels) =>
              labels.length === 0
                ? t("database.binlog.filterDatabaseAll")
                : labels.length <= 2
                  ? labels.join("、")
                  : t("database.binlog.filterSelectedCount", { count: labels.length })
            }
            aria-label={t("database.binlog.filterDatabase")}
          />
        </label>
        <label className="db-binlog-panel__filter-field db-binlog-panel__filter-field--select">
          <span className="db-binlog-panel__filter-label">{t("database.binlog.filterTables")}</span>
          <MultiSelect
            size="sm"
            className="db-binlog-panel__multi"
            values={selectedTables}
            onChange={setSelectedTables}
            options={tableSelectOptions}
            emptyMeansAll={false}
            searchable
            panelMinWidth={260}
            searchPlaceholder={t("database.binlog.filterSearch")}
            disabled={selectedDatabases.length === 0}
            placeholder={
              selectedDatabases.length === 0
                ? t("database.binlog.filterTablesNeedDb")
                : t("database.binlog.filterTablesAll")
            }
            formatDisplayLabel={(labels) =>
              selectedDatabases.length === 0
                ? t("database.binlog.filterTablesNeedDb")
                : labels.length === 0
                  ? t("database.binlog.filterTablesAll")
                  : labels.length <= 2
                    ? labels.join("、")
                    : t("database.binlog.filterSelectedCount", { count: labels.length })
            }
            aria-label={t("database.binlog.filterTables")}
          />
        </label>
        <label className="db-binlog-panel__filter-field db-binlog-panel__filter-field--select">
          <span className="db-binlog-panel__filter-label">{t("database.binlog.filterKind")}</span>
          <MultiSelect
            size="sm"
            className="db-binlog-panel__multi"
            values={kindFilter}
            onChange={setKindFilter}
            options={kindSelectOptions}
            emptyMeansAll={false}
            placeholder={t("database.binlog.filterKindAll")}
            formatDisplayLabel={(labels) =>
              labels.length === 0 ? t("database.binlog.filterKindAll") : labels.join("、")
            }
            aria-label={t("database.binlog.filterKind")}
          />
        </label>
        <label className="db-binlog-panel__filter-field db-binlog-panel__filter-field--keyword">
          <span className="db-binlog-panel__filter-label">{t("database.binlog.filterKeyword")}</span>
          <input
            className="db-binlog-panel__filter-input"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder={t("database.binlog.filterKeywordPlaceholder")}
          />
        </label>
        <div className="db-binlog-panel__actions-row">
          <div className="db-binlog-panel__feedback">
            {statusMsg ? <span className="db-binlog-panel__status-inline">{statusMsg}</span> : null}
            {error ? (
              <span className="db-binlog-panel__error-inline" title={error}>
                {error}
              </span>
            ) : null}
          </div>
          <div className="db-binlog-panel__actions">
            <button
              type="button"
              className="log-viewer-panel__btn"
              disabled={filesRefreshing || loading || backgroundLoading}
              onClick={() => void refreshFiles()}
            >
              {t("database.binlog.refreshFiles")}
            </button>
            {loading || backgroundLoading ? (
              <button
                type="button"
                className="log-viewer-panel__btn db-binlog-panel__stop-btn"
                onClick={stopLoading}
              >
                {t("database.binlog.stopLoading")}
              </button>
            ) : (
              <button
                type="button"
                className="log-viewer-panel__btn"
                disabled={installing || !canLoad}
                onClick={() => void loadTimeline()}
                title={!canLoad ? t("database.binlog.generateNeedTool") : undefined}
              >
                {t("database.binlog.loadTimeline")}
              </button>
            )}
            <button
              type="button"
              className="log-viewer-panel__btn"
              disabled={generating || installing || !canGenerate}
              onClick={() => void runGenerateFlashback()}
              title={!canGenerate ? t("database.binlog.selectRangeHint") : undefined}
            >
              {generating ? t("database.binlog.generating") : t("database.binlog.generateFlashback")}
            </button>
            <button
              type="button"
              className="log-viewer-panel__btn"
              disabled={executing || !flashbackSql.trim()}
              onClick={() => void runExecuteFlashback()}
            >
              {executing ? t("database.binlog.executing") : t("database.binlog.executeFlashback")}
            </button>
          </div>
        </div>
      </div>

      {needInstall ? (
        <div className="db-binlog-panel__install-banner">
          <span>{t("database.binlog.installBanner")}</span>
          <button
            type="button"
            className="log-viewer-panel__btn db-binlog-panel__install-btn"
            disabled={installing}
            onClick={() => void confirmAndInstallMy2sql()}
          >
            {installing ? t("database.binlog.installing") : t("database.binlog.installMy2sql")}
          </button>
        </div>
      ) : null}

      <div className="db-binlog-panel__main">
        <div className="db-binlog-panel__timeline">
          <div className="db-binlog-panel__timeline-header">
            <span>
              {t("database.binlog.selectedCount", {
                selected: selectedEvents.length,
                total: visibleEvents.length,
              })}
              {backgroundLoading ? ` · ${t("database.binlog.loadingMore")}` : ""}
            </span>
            {selectedEvents.length > 0 ? (
              <button type="button" className="log-viewer-panel__btn" onClick={clearSelection}>
                {t("database.binlog.clearSelection")}
              </button>
            ) : null}
          </div>
          {events.length > 0 && !loading ? (
            <div className="db-binlog-panel__list-cols">
              {(
                [
                  ["kind", t("database.binlog.colKind")],
                  ["time", t("database.binlog.colTime")],
                  ["table", t("database.binlog.colTable")],
                  ["pos", t("database.binlog.colPos")],
                  ["summary", t("database.binlog.colSummary")],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={`db-binlog-panel__col-btn${sortKey === key ? " is-active" : ""}`}
                  onClick={() => toggleSort(key)}
                >
                  {label}
                  {sortKey === key ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                </button>
              ))}
            </div>
          ) : null}
          {loading ? (
            <div className="db-binlog-panel__empty">{t("database.binlog.loading")}</div>
          ) : visibleEvents.length === 0 ? (
            <div className="db-binlog-panel__empty">
              {needInstall
                ? t("database.binlog.flashbackNeedToolHint")
                : events.length > 0
                  ? keyword.trim()
                    ? t("database.binlog.emptyKeywordFilter")
                    : t("database.binlog.emptyKindFilter")
                  : t("database.binlog.emptyHint")}
            </div>
          ) : useTimelineVirtual ? (
            <div className="db-binlog-panel__list db-binlog-panel__list--virtual" ref={timelineScrollRef}>
              <div
                className="db-binlog-panel__list-inner"
                style={{ height: timelineVirtualizer.getTotalSize(), position: "relative" }}
              >
                {timelineVirtualizer.getVirtualItems().map((virtualRow) => {
                  const ev = visibleEvents[virtualRow.index];
                  if (!ev) return null;
                  return (
                    <div
                      key={ev.id}
                      data-index={virtualRow.index}
                      className="db-binlog-panel__list-row"
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        height: virtualRow.size,
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                    >
                      {renderTimelineRow(ev)}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="db-binlog-panel__list" ref={timelineScrollRef}>
              {visibleEvents.map((ev) => (
                <div key={ev.id} className="db-binlog-panel__list-row">
                  {renderTimelineRow(ev)}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="db-binlog-panel__detail">
          <div className="db-binlog-panel__detail-section">
            <div className="db-binlog-panel__detail-title">{t("database.binlog.detailForward")}</div>
            <div className="db-binlog-panel__sql-editor-wrap">
              {forwardSql ? (
                <CodeEditor
                  className="db-binlog-panel__sql-editor"
                  value={forwardSql}
                  onChange={() => undefined}
                  language="sql"
                  readOnly
                  highlightQuery={sqlHighlightQuery}
                />
              ) : (
                <div className="db-binlog-panel__sql-placeholder">
                  {t("database.binlog.detailForwardPlaceholder")}
                </div>
              )}
            </div>
          </div>
          <div className="db-binlog-panel__detail-section">
            <div className="db-binlog-panel__detail-title">{t("database.binlog.detailRollback")}</div>
            <div className="db-binlog-panel__sql-editor-wrap">
              <CodeEditor
                className="db-binlog-panel__sql-editor"
                value={flashbackSql}
                onChange={setFlashbackSql}
                language="sql"
                highlightQuery={sqlHighlightQuery}
              />
              {!flashbackSql.trim() ? (
                <div className="db-binlog-panel__sql-placeholder db-binlog-panel__sql-placeholder--overlay">
                  {t("database.binlog.flashbackPlaceholder")}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
