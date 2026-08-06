import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FormDialog, FormField } from "../../../components/ui/form/FormDialog";
import { Select } from "../../../components/ui/form/Select";
import { TextInput } from "../../../components/ui/form/TextInput";
import { useI18n } from "../../../i18n";
import { showToast } from "../../../stores/toastStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import {
  introspectTable,
  listDatabases,
  listTables,
  type DbColumnMeta,
  type DbConnectionConfig,
} from "../api";
import {
  IMPORT_TO_TABLE_ROW_HARD_LIMIT,
  importQueryResultToTable,
  listConstantFillTargetColumns,
  matchColumnsByName,
  type ImportFetchProgress,
} from "./importQueryResultToTable";

export interface ImportToTableDialogPayload {
  sourceConnection: DbConnectionConfig;
  sourceSql: string;
  sourceColumns: string[];
  /** 当前页行数，仅用于提示 */
  currentPageRows: number;
  resultHasMore: boolean;
  defaultConnId?: string | null;
  defaultDatabase?: string | null;
}

interface ImportToTableDialogProps {
  open: boolean;
  payload: ImportToTableDialogPayload | null;
  connections: DbConnectionConfig[];
  databasesByConnId: Record<string, string[]>;
  onClose: () => void;
}

function isConstantFillRequired(meta?: DbColumnMeta): boolean {
  if (!meta) return false;
  if (meta.nullable !== false) return false;
  if (meta.isAutoIncrement) return false;
  return true;
}

function TargetColumnLabel({
  name,
  meta,
  t,
}: {
  name: string;
  meta?: DbColumnMeta;
  t: (key: string) => string;
}) {
  const notNull = meta?.nullable === false;
  return (
    <span className="db-import-to-table-mapping__target-col">
      <code>{name}</code>
      {notNull ? (
        <span
          className="db-data-table-th-nullability db-data-table-th-nullability--no"
          title={t("database.results.columnNotNullable")}
        >
          {t("database.results.columnNotNullableShort")}
        </span>
      ) : null}
    </span>
  );
}

export function ImportToTableDialog({
  open,
  payload,
  connections,
  databasesByConnId,
  onClose,
}: ImportToTableDialogProps) {
  const { t } = useI18n();
  const pageSize = useSettingsStore((s) => s.databaseQueryPageSize);

  const [connId, setConnId] = useState("");
  const [database, setDatabase] = useState("");
  const [tableName, setTableName] = useState("");
  const [databases, setDatabases] = useState<string[]>([]);
  const [tables, setTables] = useState<string[]>([]);
  const [targetColumnMeta, setTargetColumnMeta] = useState<DbColumnMeta[]>([]);
  const [loadingDatabases, setLoadingDatabases] = useState(false);
  const [loadingTables, setLoadingTables] = useState(false);
  const [loadingColumns, setLoadingColumns] = useState(false);
  const [clearBeforeImport, setClearBeforeImport] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ImportFetchProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [constantFills, setConstantFills] = useState<Record<string, string>>({});
  const abortRef = useRef<AbortController | null>(null);

  const connection = useMemo(
    () => connections.find((c) => c.id === connId) ?? null,
    [connections, connId],
  );

  useEffect(() => {
    if (!open || !payload) return;
    const defaultConn =
      payload.defaultConnId &&
      connections.some((c) => c.id === payload.defaultConnId)
        ? payload.defaultConnId
        : payload.sourceConnection.id;
    setConnId(defaultConn);
    setDatabase(payload.defaultDatabase?.trim() || payload.sourceConnection.database?.trim() || "");
    setTableName("");
    setTables([]);
    setTargetColumnMeta([]);
    setConstantFills({});
    setClearBeforeImport(false);
    setConfirmClear(false);
    setBusy(false);
    setProgress(null);
    setError(null);
  }, [open, payload, connections]);

  useEffect(() => {
    if (!open || !connection) {
      setDatabases([]);
      return;
    }
    const cached = databasesByConnId[connection.id];
    if (cached?.length) {
      setDatabases(cached);
      return;
    }
    let cancelled = false;
    setLoadingDatabases(true);
    void listDatabases(connection, { quiet: true })
      .then((list) => {
        if (!cancelled) setDatabases(list);
      })
      .catch((err) => {
        if (!cancelled) {
          setDatabases([]);
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingDatabases(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, connection, databasesByConnId]);

  useEffect(() => {
    if (!open || !connection || !database.trim()) {
      setTables([]);
      return;
    }
    let cancelled = false;
    setLoadingTables(true);
    setTableName("");
    setTargetColumnMeta([]);
    setConstantFills({});
    void listTables({ ...connection, database: database.trim() }, database.trim())
      .then((list) => {
        if (!cancelled) setTables(list);
      })
      .catch((err) => {
        if (!cancelled) {
          setTables([]);
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingTables(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, connection, database]);

  useEffect(() => {
    if (!open || !connection || !database.trim() || !tableName.trim()) {
      setTargetColumnMeta([]);
      return;
    }
    let cancelled = false;
    setLoadingColumns(true);
    void introspectTable(
      { ...connection, database: database.trim() },
      database.trim(),
      tableName.trim(),
    )
      .then((schema) => {
        if (!cancelled) {
          setTargetColumnMeta(schema.columns);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setTargetColumnMeta([]);
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingColumns(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, connection, database, tableName]);

  const targetColumns = useMemo(
    () => targetColumnMeta.map((column) => column.name),
    [targetColumnMeta],
  );

  const targetColumnByName = useMemo(() => {
    const map = new Map<string, DbColumnMeta>();
    for (const column of targetColumnMeta) {
      map.set(column.name.toLowerCase(), column);
    }
    return map;
  }, [targetColumnMeta]);

  const columnMatch = useMemo(() => {
    if (!payload || targetColumns.length === 0) return null;
    return matchColumnsByName(payload.sourceColumns, targetColumns);
  }, [payload, targetColumns]);

  const requiredConstantColumns = useMemo(() => {
    if (!columnMatch) return [];
    return listConstantFillTargetColumns(columnMatch, targetColumnMeta);
  }, [columnMatch, targetColumnMeta]);

  const requiredConstantFilled = useMemo(
    () =>
      requiredConstantColumns.every(
        (column) => (constantFills[column.name] ?? "").trim().length > 0,
      ),
    [constantFills, requiredConstantColumns],
  );

  const connectionOptions = useMemo(
    () => connections.map((c) => ({ value: c.id, label: c.name || c.id })),
    [connections],
  );

  const databaseOptions = useMemo(
    () =>
      databases.length > 0
        ? databases.map((name) => ({ value: name, label: name }))
        : [{ value: "", label: t("database.results.importToTable.noDatabases"), disabled: true }],
    [databases, t],
  );

  const tableOptions = useMemo(
    () =>
      tables.length > 0
        ? tables.map((name) => ({ value: name, label: name }))
        : [{ value: "", label: t("database.results.importToTable.noTables"), disabled: true }],
    [tables, t],
  );

  const canExecute =
    Boolean(connection && database.trim() && tableName.trim() && columnMatch && columnMatch.matched.length > 0) &&
    requiredConstantFilled &&
    !busy &&
    !loadingColumns;

  const progressText = useMemo(() => {
    if (!progress) return null;
    if (progress.phase === "fetching") {
      return t("database.results.importToTable.progressFetching", {
        rows: progress.fetchedRows,
      });
    }
    if (progress.phase === "clearing") {
      return t("database.results.importToTable.progressClearing");
    }
    if (progress.phase === "inserting") {
      return t("database.results.importToTable.progressInserting", {
        inserted: progress.insertedRows,
        total: progress.fetchedRows,
      });
    }
    return null;
  }, [progress, t]);

  const handleClose = useCallback(() => {
    if (busy) {
      abortRef.current?.abort();
    }
    onClose();
  }, [busy, onClose]);

  const runImport = useCallback(async () => {
    if (!payload || !connection || !canExecute || !columnMatch) return;
    if (clearBeforeImport && !confirmClear) {
      setConfirmClear(true);
      return;
    }

    setBusy(true);
    setError(null);
    setProgress({ phase: "fetching", fetchedRows: 0, insertedRows: 0 });
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const targetConnection: DbConnectionConfig = {
        ...connection,
        database: database.trim(),
      };
      const result = await importQueryResultToTable({
        sourceConnection: payload.sourceConnection,
        sourceSql: payload.sourceSql,
        targetConnection,
        targetTable: tableName.trim(),
        sourceColumns: payload.sourceColumns,
        targetColumns,
        targetColumnMeta,
        constantFills,
        clearBeforeImport,
        pageSize,
        hardLimit: IMPORT_TO_TABLE_ROW_HARD_LIMIT,
        signal: controller.signal,
        onProgress: setProgress,
      });
      showToast(
        t("database.results.importToTable.success", {
          rows: result.insertedRows,
          table: tableName.trim(),
        }),
      );
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "aborted") {
        setError(t("database.results.importToTable.cancelled"));
      } else if (message.startsWith("ROW_LIMIT:")) {
        setError(
          t("database.results.importToTable.rowLimit", {
            limit: IMPORT_TO_TABLE_ROW_HARD_LIMIT,
          }),
        );
      } else if (message === "NO_MATCHED_COLUMNS") {
        setError(t("database.results.importToTable.noMatchedColumns"));
      } else if (message.startsWith("MISSING_CONSTANT_FILL:")) {
        const column = message.slice("MISSING_CONSTANT_FILL:".length);
        setError(t("database.results.importToTable.constantFillRequired", { column }));
      } else {
        setError(message);
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      setConfirmClear(false);
    }
  }, [
    canExecute,
    clearBeforeImport,
    columnMatch,
    confirmClear,
    connection,
    database,
    onClose,
    pageSize,
    payload,
    t,
    tableName,
    targetColumns,
    targetColumnMeta,
    constantFills,
  ]);

  if (!payload) return null;

  return (
    <FormDialog
      open={open}
      onClose={handleClose}
      title={t("database.results.importToTable.title")}
      subtitle={t("database.results.importToTable.subtitle")}
      className="db-import-to-table-dialog"
      bodyClassName="db-import-to-table-dialog__body"
      size="lg"
      closeDisabled={busy}
      cancelDisabled={busy}
      status={error ? { kind: "error", message: error } : null}
      primaryAction={{
        label: busy
          ? t("database.results.importToTable.importing")
          : confirmClear
            ? t("database.results.importToTable.confirmClearAndImport")
            : t("database.results.importToTable.execute"),
        disabled: !canExecute,
        onClick: () => void runImport(),
      }}
    >
      <div className="db-import-to-table-dialog__fields">
        <FormField
          layout="horizontal"
          label={t("database.results.importToTable.connection")}
        >
          <Select
            className="db-import-to-table-dialog__select"
            value={connId}
            onChange={(value) => {
              setConnId(value);
              setDatabase("");
              setTableName("");
              setConfirmClear(false);
            }}
            options={connectionOptions}
            searchable
            size="sm"
            disabled={busy}
          />
        </FormField>

        <FormField
          layout="horizontal"
          label={t("database.results.importToTable.database")}
        >
          <Select
            className="db-import-to-table-dialog__select"
            value={database}
            onChange={(value) => {
              setDatabase(value);
              setTableName("");
              setConfirmClear(false);
            }}
            options={databaseOptions}
            searchable
            size="sm"
            disabled={busy || loadingDatabases || !connId}
            placeholder={
              loadingDatabases
                ? t("common.loading")
                : t("database.results.importToTable.selectDatabase")
            }
          />
        </FormField>

        <FormField
          layout="horizontal"
          label={t("database.results.importToTable.table")}
        >
          <Select
            className="db-import-to-table-dialog__select"
            value={tableName}
            onChange={(value) => {
              setTableName(value);
              setConstantFills({});
              setConfirmClear(false);
            }}
            options={tableOptions}
            searchable
            size="sm"
            disabled={busy || loadingTables || !database.trim()}
            placeholder={
              loadingTables
                ? t("common.loading")
                : t("database.results.importToTable.selectTable")
            }
          />
        </FormField>
      </div>

      <div className="db-import-to-table-dialog__option-row">
        <label className="db-import-to-table-clear">
          <input
            type="checkbox"
            checked={clearBeforeImport}
            disabled={busy}
            onChange={(e) => {
              setClearBeforeImport(e.target.checked);
              setConfirmClear(false);
            }}
          />
          <span>{t("database.results.importToTable.clearBeforeImport")}</span>
        </label>
        {clearBeforeImport ? (
          <div className="db-import-to-table-dialog__warn">
            {t("database.results.importToTable.clearWarning")}
          </div>
        ) : null}
      </div>

      <div className="db-import-to-table-mapping">
        <div className="db-import-to-table-mapping__header">
          <div className="db-import-to-table-mapping__title">
            {t("database.results.importToTable.mappingTitle")}
          </div>
          <div className="db-import-to-table-summary__meta">
            <span className="db-import-to-table-summary__chip">
              {t("database.results.importToTable.sourceHint", {
                columns: payload.sourceColumns.length,
                rows: payload.resultHasMore
                  ? `${payload.currentPageRows}+`
                  : payload.currentPageRows,
              })}
            </span>
            {columnMatch ? (
              <span className="db-import-to-table-summary__chip db-import-to-table-summary__chip--ok">
                {t("database.results.importToTable.matchedCount", {
                  count: columnMatch.matched.length,
                })}
              </span>
            ) : null}
          </div>
        </div>

        {loadingColumns ? (
          <div className="db-import-to-table-summary__line">
            {t("database.results.importToTable.loadingColumns")}
          </div>
        ) : columnMatch ? (
          <div className="db-import-to-table-mapping__table-wrap">
            <table className="db-import-to-table-mapping__table">
              <thead>
                <tr>
                  <th>{t("database.results.importToTable.sourceOrFillColumn")}</th>
                  <th className="db-import-to-table-mapping__arrow" aria-hidden />
                  <th>{t("database.results.importToTable.targetColumn")}</th>
                  <th>{t("database.results.importToTable.mappingStatus")}</th>
                </tr>
              </thead>
              <tbody>
                {columnMatch.matched.map((pair) => (
                  <tr key={`m:${pair.source}->${pair.target}`}>
                    <td>
                      <code>{pair.source}</code>
                    </td>
                    <td className="db-import-to-table-mapping__arrow">→</td>
                    <td>
                      <TargetColumnLabel
                        name={pair.target}
                        meta={targetColumnByName.get(pair.target.toLowerCase())}
                        t={t}
                      />
                    </td>
                    <td>
                      <span className="db-import-to-table-mapping__badge db-import-to-table-mapping__badge--ok">
                        {t("database.results.importToTable.statusMapped")}
                      </span>
                    </td>
                  </tr>
                ))}
                {columnMatch.sourceOnly.map((name) => (
                  <tr key={`s:${name}`} className="db-import-to-table-mapping__row--muted">
                    <td>
                      <code>{name}</code>
                    </td>
                    <td className="db-import-to-table-mapping__arrow">→</td>
                    <td className="db-import-to-table-mapping__empty">—</td>
                    <td>
                      <span className="db-import-to-table-mapping__badge db-import-to-table-mapping__badge--skip">
                        {t("database.results.importToTable.statusSkipped")}
                      </span>
                    </td>
                  </tr>
                ))}
                {columnMatch.targetOnly.map((name) => {
                  const meta = targetColumnByName.get(name.toLowerCase());
                  const needsConstant = isConstantFillRequired(meta);
                  const isAutoIncrement = meta?.isAutoIncrement === true;
                  return (
                  <tr key={`t:${name}`} className="db-import-to-table-mapping__row--muted">
                    <td>
                      {needsConstant ? (
                        <TextInput
                          className="input db-import-to-table-mapping__constant-input"
                          value={constantFills[name] ?? ""}
                          onChange={(value) => {
                            setConstantFills((prev) => ({ ...prev, [name]: value }));
                          }}
                          disabled={busy}
                          size="sm"
                          clearable={false}
                          copyable={false}
                          placeholder={t("database.results.importToTable.constantFillPlaceholder")}
                          aria-label={t("database.results.importToTable.constantFillFor", { column: name })}
                        />
                      ) : (
                        <span className="db-import-to-table-mapping__empty">—</span>
                      )}
                    </td>
                    <td className="db-import-to-table-mapping__arrow">→</td>
                    <td>
                      <TargetColumnLabel
                        name={name}
                        meta={meta}
                        t={t}
                      />
                    </td>
                    <td>
                      {needsConstant ? (
                        <span className="db-import-to-table-mapping__badge db-import-to-table-mapping__badge--constant">
                          {t("database.results.importToTable.statusConstant")}
                        </span>
                      ) : isAutoIncrement ? (
                        <span className="db-import-to-table-mapping__badge db-import-to-table-mapping__badge--skip">
                          {t("database.results.importToTable.statusAutoIncrement")}
                        </span>
                      ) : (
                        <span className="db-import-to-table-mapping__badge db-import-to-table-mapping__badge--miss">
                          {t("database.results.importToTable.statusUnmatched")}
                        </span>
                      )}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
            {columnMatch.matched.length === 0 ? (
              <div className="db-import-to-table-summary__line db-import-to-table-summary__line--warn">
                {t("database.results.importToTable.noMatchedColumns")}
              </div>
            ) : null}
          </div>
        ) : tableName ? (
          <div className="db-import-to-table-summary__line db-import-to-table-summary__line--warn">
            {t("database.results.importToTable.noMatchedColumns")}
          </div>
        ) : (
          <div className="db-import-to-table-summary__line db-import-to-table-summary__line--muted">
            {t("database.results.importToTable.selectTableHint")}
          </div>
        )}

        <div className="db-import-to-table-summary__hint">
          {t("database.results.importToTable.fullResultHint", {
            limit: IMPORT_TO_TABLE_ROW_HARD_LIMIT.toLocaleString(),
          })}
        </div>
        {progressText ? (
          <div className="db-import-to-table-summary__progress">{progressText}</div>
        ) : null}
      </div>
    </FormDialog>
  );
}
