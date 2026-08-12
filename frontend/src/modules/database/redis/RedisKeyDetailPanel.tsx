import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { useI18n } from "../../../i18n";
import { Button } from "../../../components/ui/primitives/Button";
import { DockHandle, DockLayout, DockPanel } from "../../../components/dock";
import {
  isRedisConnection,
  redisDeleteKey,
  redisKeyDetail,
  type DbColumnMeta,
  type DbConnectionConfig,
  type RedisKeyDetail,
} from "../api";
import { connectionWithDatabase } from "../toolbox/types";
import { TableDataGrid, type TableDataGridActiveCell } from "../grid/TableDataGrid";
import { CellEditorPanel, type CellEditorPanelHandle } from "../cell_editor";
import { RedisStreamOpsPanel } from "./RedisStreamOpsPanel";
import { RedisStreamMonitorStrip } from "./RedisStreamMonitorStrip";
import { useRedisStreamMonitor } from "./useRedisStreamMonitor";
import { RedisKeyCrudToolbar } from "./RedisKeyCrudToolbar";
import { RedisStringValueView } from "./RedisBinaryValueView";
import { formatRedisKeyDetailError, isRedisKeyNotFoundError } from "./redisKeyErrors";

type StreamDetailTab = "entries" | "ops";

/** 底部单元格预览：与表预览底栏一致（px 字符串供 react-resizable-panels） */
const REDIS_CELL_EDITOR_DEFAULT_SIZE = "280px";
const REDIS_CELL_EDITOR_MIN_SIZE = "180px";
const REDIS_GRID_MIN_SIZE = "120px";

interface RedisKeyDetailPanelProps {
  connection: DbConnectionConfig;
  dbName: string;
  selectedKey: string | null;
  active?: boolean;
  onDeleted?: (key: string) => void;
  onKeyMissing?: (key: string) => void;
}

function formatBytes(size: number | null | undefined): string {
  if (size == null || Number.isNaN(size)) {
    return "—";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTtl(ttl: number, t: (key: string) => string): string {
  if (ttl < 0) {
    return t("database.redisQuery.neverExpire");
  }
  if (ttl < 60) {
    return `${ttl}s`;
  }
  if (ttl < 3600) {
    return `${Math.floor(ttl / 60)}m ${ttl % 60}s`;
  }
  const hours = Math.floor(ttl / 3600);
  const minutes = Math.floor((ttl % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function parseValueJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function looksLikeJson(value: unknown): boolean {
  if (value != null && typeof value === "object") {
    return true;
  }
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

function inferRedisColumnType(column: string, value: unknown): string {
  if (column === "score" || column === "index") {
    return "number";
  }
  if (looksLikeJson(value)) {
    return "json";
  }
  return "text";
}

export function RedisKeyDetailPanel({
  connection,
  dbName,
  selectedKey,
  active = true,
  onDeleted,
  onKeyMissing,
}: RedisKeyDetailPanelProps) {
  const { t } = useI18n();
  const capable = isRedisConnection(connection);
  const [detail, setDetail] = useState<RedisKeyDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [activeCell, setActiveCell] = useState<TableDataGridActiveCell | null>(null);
  const [cellEditorCollapsed, setCellEditorCollapsed] = useState(false);
  const [streamTab, setStreamTab] = useState<StreamDetailTab>("ops");
  const cellEditorRef = useRef<CellEditorPanelHandle>(null);
  const cellEditorPanelRef = useRef<PanelImperativeHandle | null>(null);

  const scopedConnection = useMemo(
    () => connectionWithDatabase(connection, dbName),
    [connection, dbName],
  );

  const isStreamKey = detail?.keyType === "stream";
  const streamMonitor = useRedisStreamMonitor({
    connection: scopedConnection,
    streamKey: isStreamKey && detail ? detail.key : null,
    enabled: active && Boolean(isStreamKey && detail?.key),
  });

  const refresh = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!capable || !selectedKey) {
        setDetail(null);
        return;
      }
      const silent = options?.silent ?? false;
      if (!silent) {
        setLoading(true);
      }
      setError(null);
      try {
        const next = await redisKeyDetail(scopedConnection, selectedKey, { quiet: true });
        setDetail(next);
      } catch (e) {
        if (isRedisKeyNotFoundError(e)) {
          onKeyMissing?.(selectedKey);
          setDetail(null);
          setError(t("database.redisQuery.keyMissing", { key: selectedKey }));
        } else {
          setError(formatRedisKeyDetailError(e));
          if (!silent) {
            setDetail(null);
          }
        }
      } finally {
        if (!silent) {
          setLoading(false);
        }
      }
    },
    [capable, selectedKey, scopedConnection, onKeyMissing, t],
  );

  useEffect(() => {
    if (!active) {
      return;
    }
    if (!selectedKey) {
      setDetail(null);
      setError(null);
      setActiveCell(null);
      return;
    }
    setActiveCell(null);
    setStreamTab("ops");
    void refresh();
  }, [active, selectedKey, refresh]);

  const handleCopy = useCallback(async () => {
    if (!selectedKey) {
      return;
    }
    try {
      await navigator.clipboard.writeText(selectedKey);
    } catch {
      /* ignore */
    }
  }, [selectedKey]);

  const handleDelete = useCallback(async () => {
    if (!selectedKey || !capable) {
      return;
    }
    const ok = window.confirm(t("database.redisQuery.deleteConfirm", { key: selectedKey }));
    if (!ok) {
      return;
    }
    setDeleting(true);
    try {
      await redisDeleteKey(scopedConnection, selectedKey);
      setDetail(null);
      onDeleted?.(selectedKey);
    } catch (e) {
      setError(typeof e === "string" ? e : JSON.stringify(e));
    } finally {
      setDeleting(false);
    }
  }, [selectedKey, capable, scopedConnection, onDeleted, t]);

  const parsedValue = useMemo(
    () => (detail ? parseValueJson(detail.valueJson) : null),
    [detail],
  );

  const stringValue = typeof parsedValue === "string" ? parsedValue : null;
  const streamEntries = useMemo(() => {
    if (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue)) {
      return null;
    }
    const obj = parsedValue as { entries?: Record<string, unknown>[] };
    return Array.isArray(obj.entries) ? obj.entries : null;
  }, [parsedValue]);
  const tableRows = useMemo(() => {
    if (streamEntries) {
      return streamEntries;
    }
    return Array.isArray(parsedValue) ? (parsedValue as Record<string, unknown>[]) : null;
  }, [parsedValue, streamEntries]);
  const tableColumns = useMemo(() => {
    if (!tableRows) {
      return [] as string[];
    }
    if (tableRows.length > 0) {
      return Object.keys(tableRows[0]!);
    }
    return ["index", "value"];
  }, [tableRows]);

  const columnMeta = useMemo<DbColumnMeta[]>(() => {
    if (!tableRows || tableColumns.length === 0) {
      return [];
    }
    const sample = tableRows[0] ?? {};
    return tableColumns.map((name) => ({
      name,
      type: inferRedisColumnType(name, sample[name]),
      isPk: false,
      isFk: false,
      nullable: true,
    }));
  }, [tableColumns, tableRows]);

  const activeCellKey = useMemo(() => {
    if (!activeCell) {
      return null;
    }
    return `${activeCell.rowIndex}:${activeCell.column}`;
  }, [activeCell]);

  const editorColumnName = activeCell?.column ?? null;
  const activeCellValue = activeCell ? activeCell.row[activeCell.column] : undefined;
  const editorColumnType = useMemo(() => {
    if (!editorColumnName) {
      return "text";
    }
    return inferRedisColumnType(editorColumnName, activeCellValue);
  }, [editorColumnName, activeCellValue]);

  const handleActiveCellChange = useCallback((cell: TableDataGridActiveCell | null) => {
    setActiveCell(cell);
  }, []);

  const handleCellEditorCollapsedChange = useCallback(() => {
    const handle = cellEditorPanelRef.current;
    if (!handle) {
      return;
    }
    if (handle.isCollapsed()) {
      handle.expand();
      setCellEditorCollapsed(false);
    } else {
      handle.collapse();
      setCellEditorCollapsed(true);
    }
  }, []);

  const handleCellEditorPanelResize = useCallback(() => {
    const collapsed = cellEditorPanelRef.current?.isCollapsed() ?? false;
    setCellEditorCollapsed(collapsed);
  }, []);

  const handleCellEditorFocusRequest = useCallback(() => {
    const handle = cellEditorPanelRef.current;
    if (handle?.isCollapsed()) {
      handle.expand();
      setCellEditorCollapsed(false);
    }
    requestAnimationFrame(() => {
      cellEditorRef.current?.focusEditor();
    });
  }, []);

  const handlePreviewApply = useCallback(() => {
    /* Redis 键字段目前只读预览，不落库 */
  }, []);

  if (!selectedKey) {
    return (
      <div className="redis-key-detail redis-key-detail--empty">
        {t("database.redisQuery.selectKeyHint")}
      </div>
    );
  }

  if (loading && !detail) {
    return <div className="redis-key-detail redis-key-detail--empty">{t("common.loading")}</div>;
  }

  if (error && !detail) {
    return <div className="redis-key-detail redis-key-detail--error">{error}</div>;
  }

  if (!detail) {
    return (
      <div className="redis-key-detail redis-key-detail--empty">
        {t("database.redisQuery.selectKeyHint")}
      </div>
    );
  }

  const tableGrid = tableRows ? (
    <TableDataGrid
      columns={tableColumns}
      rows={tableRows}
      columnMeta={columnMeta}
      totalRows={tableRows.length}
      page={0}
      pageSize={Math.max(tableRows.length, 1)}
      loading={false}
      onPageChange={() => {}}
      onActiveCellChange={handleActiveCellChange}
      cellEditorCollapsed={cellEditorCollapsed}
      onCellEditorCollapsedChange={handleCellEditorCollapsedChange}
      onCellEditorFocusRequest={handleCellEditorFocusRequest}
    />
  ) : null;

  const streamTabBar =
    detail.keyType === "stream" ? (
      <div
        className="redis-key-detail-stream-tabs"
        role="tablist"
        aria-label={`${t("database.redisOps.streamEntries")} / ${t("database.redisOps.streamOps")}`}
      >
        <button
          type="button"
          role="tab"
          aria-selected={streamTab === "entries"}
          className={`redis-key-detail-stream-tab${streamTab === "entries" ? " is-active" : ""}`}
          onClick={() => setStreamTab("entries")}
        >
          {t("database.redisOps.streamEntries")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={streamTab === "ops"}
          className={`redis-key-detail-stream-tab${streamTab === "ops" ? " is-active" : ""}`}
          onClick={() => setStreamTab("ops")}
        >
          {t("database.redisOps.streamOps")}
        </button>
      </div>
    ) : null;

  const renderStreamChrome = (toolbar?: ReactNode) => (
    <div className="redis-key-detail-stream-chrome">
      {streamTabBar}
      {toolbar ? <div className="redis-key-detail-stream-chrome__toolbar">{toolbar}</div> : null}
    </div>
  );

  const streamEntriesPanel =
    stringValue != null ? (
      <RedisStringValueView value={stringValue} sizeBytes={detail?.sizeBytes} />
    ) : tableGrid ? (
      <DockLayout direction="vertical" className="redis-key-detail-split">
        <DockPanel minSize={REDIS_GRID_MIN_SIZE}>
          <div className="redis-key-detail-grid-pane">{tableGrid}</div>
        </DockPanel>
        <DockHandle direction="vertical" />
        <DockPanel
          defaultSize={REDIS_CELL_EDITOR_DEFAULT_SIZE}
          minSize={REDIS_CELL_EDITOR_MIN_SIZE}
          collapsible
          collapsedSize={0}
          panelRef={cellEditorPanelRef}
          onResize={handleCellEditorPanelResize}
          className="dock-panel-bottom db-cell-editor-dock-bottom"
        >
          <CellEditorPanel
            ref={cellEditorRef}
            cellKey={activeCellKey}
            columnName={editorColumnName}
            columnType={editorColumnType}
            currentValue={activeCellValue}
            selectionCount={activeCell ? 1 : 0}
            editorOpen={!cellEditorCollapsed}
            readOnly
            onApply={handlePreviewApply}
          />
        </DockPanel>
      </DockLayout>
    ) : (
      <pre className="redis-key-detail-string">{JSON.stringify(parsedValue, null, 2)}</pre>
    );

  return (
    <div className={`redis-key-detail${detail.keyType === "stream" ? " redis-key-detail--stream" : ""}`}>
      <div className="redis-key-detail-header">
        <div className="redis-key-detail-name" title={detail.key}>
          {detail.key}
        </div>
        <div className="redis-key-detail-actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void refresh();
              if (detail.keyType === "stream") {
                void streamMonitor.refresh();
              }
            }}
            disabled={loading}
          >
            {t("common.refresh")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void handleCopy()}>
            {t("common.copy")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void handleDelete()}
            disabled={deleting}
          >
            {t("common.delete")}
          </Button>
        </div>
      </div>
      {detail.keyType === "stream" ? (
        <div className="redis-key-detail-meta redis-key-detail-meta--stream">
          <div className="redis-key-detail-meta-primary">
            <span className="redis-key-type-badge">{detail.keyType.toUpperCase()}</span>
            <span>{formatBytes(detail.sizeBytes)}</span>
            <span>{formatTtl(detail.ttl, t)}</span>
          </div>
          <RedisStreamMonitorStrip monitor={streamMonitor} />
        </div>
      ) : (
        <div className="redis-key-detail-meta">
          <span className="redis-key-type-badge">{detail.keyType.toUpperCase()}</span>
          <span>
            {t("database.redisQuery.sizeLabel")}: {formatBytes(detail.sizeBytes)}
          </span>
          <span>{formatTtl(detail.ttl, t)}</span>
        </div>
      )}
      {detail.keyType !== "stream" ? (
        <RedisKeyCrudToolbar
          connection={scopedConnection}
          keyName={detail.key}
          keyType={detail.keyType}
          onChanged={() => void refresh({ silent: true })}
        />
      ) : null}
      {error ? <div className="redis-key-detail-inline-error">{error}</div> : null}
      <div
        className={`redis-key-detail-body${
          detail.keyType === "stream" ? " redis-key-detail-body--stream" : ""
        }${
          tableGrid && (detail.keyType !== "stream" || streamTab === "entries")
            ? " redis-key-detail-body--grid"
            : ""
        }${detail.keyType === "stream" && streamTab === "ops" ? " redis-key-detail-body--stream-ops" : ""}`}
      >
        {detail.keyType === "stream" && streamTab === "ops" ? (
          <RedisStreamOpsPanel
            connection={scopedConnection}
            streamKey={detail.key}
            monitor={streamMonitor}
            renderChrome={(toolbar) => renderStreamChrome(toolbar)}
          />
        ) : detail.keyType === "stream" ? (
          <>
            {renderStreamChrome()}
            <div className="redis-key-detail-stream-panel">{streamEntriesPanel}</div>
          </>
        ) : stringValue != null ? (
          <RedisStringValueView value={stringValue} sizeBytes={detail.sizeBytes} />
        ) : tableGrid ? (
          <DockLayout direction="vertical" className="redis-key-detail-split">
            <DockPanel minSize={REDIS_GRID_MIN_SIZE}>
              <div className="redis-key-detail-grid-pane">{tableGrid}</div>
            </DockPanel>
            <DockHandle direction="vertical" />
            <DockPanel
              defaultSize={REDIS_CELL_EDITOR_DEFAULT_SIZE}
              minSize={REDIS_CELL_EDITOR_MIN_SIZE}
              collapsible
              collapsedSize={0}
              panelRef={cellEditorPanelRef}
              onResize={handleCellEditorPanelResize}
              className="dock-panel-bottom db-cell-editor-dock-bottom"
            >
              <CellEditorPanel
                ref={cellEditorRef}
                cellKey={activeCellKey}
                columnName={editorColumnName}
                columnType={editorColumnType}
                currentValue={activeCellValue}
                selectionCount={activeCell ? 1 : 0}
                editorOpen={!cellEditorCollapsed}
                readOnly
                onApply={handlePreviewApply}
              />
            </DockPanel>
          </DockLayout>
        ) : (
          <pre className="redis-key-detail-string">
            {JSON.stringify(parsedValue, null, 2)}
          </pre>
        )}
      </div>
      {detail.valueTruncated ? (
        <div className="redis-key-detail-footer">
          {t("database.redisQuery.valueTruncated")}
        </div>
      ) : null}
    </div>
  );
}
