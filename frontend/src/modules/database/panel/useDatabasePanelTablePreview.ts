import {
  startTransition,
  useCallback,
  type Dispatch,
  type SetStateAction,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { yieldToMain } from "../../../lib/yieldToMain";
import {
  applyTablePreviewDataProgressive,
  beginTablePreviewFetch,
  bumpTablePreviewApplyGeneration,
} from "../workspace/applyTablePreviewData";
import { showToast } from "../../../stores/toastStore";
import { useDbSchemaCacheStore } from "../../../stores/dbSchemaCacheStore";
import {
  countTable,
  previewTable,
  isQdrantConnection,
  qdrantDeletePoints,
  type DbColumnMeta,
  type DbConnectionConfig,
} from "../api";
import { fetchAndApplyTableColumnMeta, isAutoIncrementColumn } from "../shared/columnMetaUtils";
import { isSameCellValue } from "../cell_editor";
import { buildRedisColumnMeta, buildRedisUpdateCommands } from "../redis/redisTableMeta";
import { getCachedTableColumns } from "../schema/schemaCacheMerge";
import { escapeSqlLiteral } from "../sql/escapeSqlLiteral";
import { makeQueryRunId } from "../sql/queryRun";
import { fetchTablePreviewPage } from "../grid/tablePreviewQuery";
import type { RuleGroupType } from "react-querybuilder";
import {
  createDefaultTablePreviewState,
  estimateTablePreviewTotalRows,
  clampTablePreviewPageSize,
  NEW_ROW_KEY_PREFIX,
  DELETED_ROW_KEY_PREFIX,
  PENDING_INSERT_ROW_KEY,
  resolvePreviewRowKey,
  normalizeSortStates,
  type SortState,
  type SortStates,
  type TablePreviewState,
} from "../workspace/dbWorkspaceState";
import { useDbWorkspaceTabStore } from "../../../stores/dbWorkspaceTabStore";
import {
  parseQdrantPointId,
  readRowKeyValue,
} from "../workspace/dbWorkspaceTabHelpers";

type Translate = (key: string, params?: Record<string, string | number>) => string;
type SetTablePreviews = ReturnType<typeof useDbWorkspaceTabStore.getState>["setTablePreviews"];
type SetTableColumnMeta = ReturnType<typeof useDbWorkspaceTabStore.getState>["setTableColumnMeta"];
type SetTabDirtyRows = ReturnType<typeof useDbWorkspaceTabStore.getState>["setTabDirtyRows"];
type SetCommittingTabs = ReturnType<typeof useDbWorkspaceTabStore.getState>["setCommittingTabs"];

export type TableRowEditState = {
  tabId: string;
  column: string;
  row: Record<string, unknown>;
  isNewRow?: boolean;
} | null;

export type UseDatabasePanelTablePreviewDeps = {
  connections: DbConnectionConfig[];
  setTablePreviews: SetTablePreviews;
  setTableColumnMeta: SetTableColumnMeta;
  setTabDirtyRows: SetTabDirtyRows;
  setCommittingTabs: SetCommittingTabs;
  setRowEdit: Dispatch<SetStateAction<TableRowEditState>>;
  rowEdit: TableRowEditState;
  t: Translate;
};

export function useDatabasePanelTablePreview(deps: UseDatabasePanelTablePreviewDeps) {
  const {
    connections,
    setTablePreviews,
    setTableColumnMeta,
    setTabDirtyRows,
    setCommittingTabs,
    setRowEdit,
    rowEdit,
    t,
  } = deps;

  const loadTablePreview = useCallback(
    async (tabId: string, connection: DbConnectionConfig, dbName: string, tableName: string) => {
      const connForSchema = { ...connection, database: dbName };
      const defaultState = createDefaultTablePreviewState();
      const pageSize =
        useDbWorkspaceTabStore.getState().tablePreviews[tabId]?.pageSize ?? defaultState.pageSize;

      const applyGeneration = beginTablePreviewFetch(tabId, setTablePreviews, {
        connId: connection.id,
        dbName,
        tableName,
        pageSize,
        page: 0,
        sort: null,
        filter: null,
      });

      if (connection.db_type !== "redis") {
        setTableColumnMeta((prevMeta) => {
          const next = { ...prevMeta };
          delete next[tabId];
          return next;
        });
        const cachedColumns = getCachedTableColumns(
          useDbSchemaCacheStore.getState().snapshot,
          connection.id,
          dbName,
          tableName,
        );
        if (cachedColumns?.length) {
          setTableColumnMeta((prevMeta) => ({ ...prevMeta, [tabId]: cachedColumns }));
        }
        fetchAndApplyTableColumnMeta(tabId, connection, dbName, tableName, (columns) => {
          startTransition(() => {
            setTableColumnMeta((prevMeta) => ({ ...prevMeta, [tabId]: columns }));
          });
        });
      }

      const countPromise = countTable(connForSchema, tableName, dbName).catch(() => null);

      try {
        const data = await previewTable(connForSchema, tableName, pageSize, 0);
        const rowCount = data.rows.length;
        const estimatedTotal = estimateTablePreviewTotalRows(0, pageSize, rowCount);
        // IPC JSON 反序列化占主线程；先让出，再分片灌行（避免一次 setState 堵死侧栏）
        await yieldToMain();
        await applyTablePreviewDataProgressive({
          tabId,
          data,
          totalRows: estimatedTotal,
          page: 0,
          pageSize,
          setTablePreviews,
          generation: applyGeneration,
          canvasMode: true,
        });
        if (connection.db_type === "redis") {
          setTableColumnMeta((prev) => ({
            ...prev,
            [tabId]: buildRedisColumnMeta(data.columns),
          }));
        }

        void countPromise.then((totalRows) => {
          if (totalRows == null) {
            return;
          }
          setTablePreviews((prevMap) => {
            const cur = prevMap[tabId];
            if (!cur) {
              return prevMap;
            }
            return { ...prevMap, [tabId]: { ...cur, totalRows } };
          });
        });
      } catch (e) {
        bumpTablePreviewApplyGeneration(tabId);
        setTablePreviews((prevMap) => ({
          ...prevMap,
          [tabId]: {
            ...(prevMap[tabId] ?? defaultState),
            loading: false,
            error: typeof e === "string" ? e : String(e),
          },
        }));
      }
    },
    [setTablePreviews, setTableColumnMeta],
  );

  const refreshTablePreview = useCallback(
    (tabId: string, connId: string, dbName: string, tableName: string) => {
      const connection = connections.find((c) => c.id === connId);
      if (!connection) return;

      const existing =
        useDbWorkspaceTabStore.getState().tablePreviews[tabId] ??
        createDefaultTablePreviewState();
      const pageSize = existing.pageSize;
      const page = existing.page;
      const sort = existing.sort;
      const filter = existing.filter;
      const columnRelations = existing.columnRelations ?? {};
      const colMeta = useDbWorkspaceTabStore.getState().tableColumnMeta[tabId];

      // 显式刷新必须硬重置 cache：clear 会让 Canvas 回退旧 displayRows，表现为刷不到外部改动
      const applyGeneration = bumpTablePreviewApplyGeneration(tabId, { resetCache: true });
      setTablePreviews((prev) => {
        const cur = prev[tabId] ?? createDefaultTablePreviewState();
        return {
          ...prev,
          [tabId]: {
            ...cur,
            loading: true,
            error: null,
            // 清行保留列 / 视图配置，避免壳闪没的同时杜绝旧行残留
            data: cur.data
              ? { name: cur.data.name, columns: cur.data.columns, rows: [] }
              : null,
          },
        };
      });

      void fetchTablePreviewPage({
        connection,
        connId,
        tableName,
        dbName,
        page,
        pageSize,
        sort,
        filter,
        columnMeta: colMeta,
        columnRelations,
      })
        .then(async ({ data, totalRows = 0 }) => {
          await yieldToMain();
          await applyTablePreviewDataProgressive({
            tabId,
            data,
            totalRows,
            page,
            pageSize,
            setTablePreviews,
            generation: applyGeneration,
            canvasMode: true,
          });
        })
        .catch((e) => {
          bumpTablePreviewApplyGeneration(tabId, { resetCache: true });
          setTablePreviews((p) => {
            const cur = p[tabId];
            if (!cur) return p;
            return {
              ...p,
              [tabId]: {
                ...cur,
                loading: false,
                error: typeof e === "string" ? e : String(e),
              },
            };
          });
        });
    },
    [connections, setTablePreviews],
  );

  const goToPage = useCallback(
    (tabId: string, connId: string, dbName: string, tableName: string, page: number) => {
      const connection = connections.find((c) => c.id === connId);
      if (!connection) return;
      const applyGeneration = bumpTablePreviewApplyGeneration(tabId);
      setTablePreviews((prev) => {
        const existing = prev[tabId] ?? createDefaultTablePreviewState();
        const pageSize = existing.pageSize;
        const colMeta = useDbWorkspaceTabStore.getState().tableColumnMeta[tabId];
        const columnRelations = existing.columnRelations ?? {};
        const totalRows = existing.totalRows;

        void fetchTablePreviewPage({
          connection,
          connId,
          tableName,
          dbName,
          page,
          pageSize,
          sort: existing.sort,
          filter: existing.filter,
          columnMeta: colMeta,
          columnRelations,
          skipCount: true,
        })
          .then(async ({ data }) => {
            await yieldToMain();
            await applyTablePreviewDataProgressive({
              tabId,
              data,
              totalRows,
              page,
              pageSize,
              setTablePreviews,
              generation: applyGeneration,
              canvasMode: true,
            });
          })
          .catch((e) => {
            bumpTablePreviewApplyGeneration(tabId);
            setTablePreviews((p) => {
              const cur = p[tabId];
              if (!cur) return p;
              return {
                ...p,
                [tabId]: {
                  ...cur,
                  loading: false,
                  error: typeof e === "string" ? e : String(e),
                },
              };
            });
          });

        return { ...prev, [tabId]: { ...existing, loading: true } };
      });
    },
    [connections, setTablePreviews],
  );

  const setTablePageSize = useCallback(
    (tabId: string, nextPageSize: number) => {
      const preview = useDbWorkspaceTabStore.getState().tablePreviews[tabId];
      if (!preview?.connId || !preview?.dbName || !preview?.tableName) return;
      const pageSize = clampTablePreviewPageSize(nextPageSize);
      if (pageSize === preview.pageSize) return;
      const connId = preview.connId;
      const connection = connections.find((c) => c.id === connId);
      if (!connection) return;
      const applyGeneration = bumpTablePreviewApplyGeneration(tabId);

      setTablePreviews((prev) => {
        const existing = prev[tabId] ?? createDefaultTablePreviewState();
        const colMeta = useDbWorkspaceTabStore.getState().tableColumnMeta[tabId];
        const columnRelations = existing.columnRelations ?? {};

        void fetchTablePreviewPage({
          connection,
          connId,
          tableName: preview.tableName!,
          dbName: preview.dbName!,
          page: 0,
          pageSize,
          sort: existing.sort,
          filter: existing.filter,
          columnMeta: colMeta,
          columnRelations,
        })
          .then(async ({ data, totalRows = 0 }) => {
            await yieldToMain();
            await applyTablePreviewDataProgressive({
              tabId,
              data,
              totalRows,
              page: 0,
              pageSize,
              setTablePreviews,
              generation: applyGeneration,
              canvasMode: true,
            });
          })
          .catch((e) => {
            bumpTablePreviewApplyGeneration(tabId);
            setTablePreviews((p) => {
              const cur = p[tabId];
              if (!cur) return p;
              return {
                ...p,
                [tabId]: {
                  ...cur,
                  loading: false,
                  error: typeof e === "string" ? e : String(e),
                },
              };
            });
          });

        return {
          ...prev,
          [tabId]: { ...existing, page: 0, pageSize, loading: true, error: null },
        };
      });
    },
    [connections, setTablePreviews],
  );

  const setTableFilter = useCallback(
    (tabId: string, filter: RuleGroupType | null) => {
      const preview = useDbWorkspaceTabStore.getState().tablePreviews[tabId];
      if (!preview?.connId || !preview?.dbName || !preview?.tableName) return;
      const connId = preview.connId;
      const connection = connections.find((c) => c.id === connId);
      if (!connection) return;

      const existing = preview;
      const pageSize = existing.pageSize;
      const colMeta = useDbWorkspaceTabStore.getState().tableColumnMeta[tabId];
      const columnRelations = existing.columnRelations ?? {};
      const applyGeneration = beginTablePreviewFetch(tabId, setTablePreviews, {
        filter,
        page: 0,
      });

      void fetchTablePreviewPage({
        connection,
        connId,
        tableName: preview.tableName!,
        dbName: preview.dbName!,
        page: 0,
        pageSize,
        sort: existing.sort,
        filter,
        columnMeta: colMeta,
        columnRelations,
      })
        .then(async ({ data, totalRows = 0 }) => {
          await yieldToMain();
          await applyTablePreviewDataProgressive({
            tabId,
            data,
            totalRows,
            page: 0,
            pageSize,
            setTablePreviews,
            generation: applyGeneration,
            canvasMode: true,
          });
          setTablePreviews((p) => {
            const cur = p[tabId];
            if (!cur) return p;
            return { ...p, [tabId]: { ...cur, filter } };
          });
        })
        .catch((e) => {
          bumpTablePreviewApplyGeneration(tabId);
          setTablePreviews((p) => {
            const cur = p[tabId];
            if (!cur) return p;
            return {
              ...p,
              [tabId]: {
                ...cur,
                loading: false,
                error: typeof e === "string" ? e : String(e),
                filter,
              },
            };
          });
        });
    },
    [connections, setTablePreviews],
  );

  const clearTabDirty = useCallback((tabId: string) => {
    setTabDirtyRows((prev) => {
      if (!(tabId in prev)) return prev;
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
    useDbWorkspaceTabStore.getState().clearTabDirtyHistory(tabId);
  }, []);

  const undoTabDirty = useCallback((tabId: string) => {
    useDbWorkspaceTabStore.getState().undoTabDirty(tabId);
  }, []);

  const redoTabDirty = useCallback((tabId: string) => {
    useDbWorkspaceTabStore.getState().redoTabDirty(tabId);
  }, []);

  const refreshTabPreviewNow = useCallback(
    (tabId: string) => {
      const preview = useDbWorkspaceTabStore.getState().tablePreviews[tabId];
      if (!preview?.connId || !preview?.dbName || !preview?.tableName) return;
      refreshTablePreview(tabId, preview.connId, preview.dbName, preview.tableName);
    },
    [refreshTablePreview],
  );

  const goToPageNow = useCallback(
    (tabId: string, page: number) => {
      const preview = useDbWorkspaceTabStore.getState().tablePreviews[tabId];
      if (!preview?.connId || !preview?.dbName || !preview?.tableName) return;
      goToPage(tabId, preview.connId, preview.dbName, preview.tableName, page);
    },
    [goToPage],
  );

  const setTableSort = useCallback(
    (tabId: string, sort: SortState | SortStates | null) => {
      const preview = useDbWorkspaceTabStore.getState().tablePreviews[tabId];
      if (!preview?.connId || !preview?.dbName || !preview?.tableName) return;
      const connId = preview.connId;
      const connection = connections.find((c) => c.id === connId);
      if (!connection) return;
      const sorts = normalizeSortStates(sort);

      setTablePreviews((prev) => {
        const existing = prev[tabId] ?? createDefaultTablePreviewState();
        const pageSize = existing.pageSize;
        const colMeta = useDbWorkspaceTabStore.getState().tableColumnMeta[tabId];
        const columnRelations = existing.columnRelations ?? {};
        const applyGeneration = bumpTablePreviewApplyGeneration(tabId);

        void fetchTablePreviewPage({
          connection,
          connId,
          tableName: preview.tableName!,
          dbName: preview.dbName!,
          page: 0,
          pageSize,
          sort: sorts,
          filter: existing.filter,
          columnMeta: colMeta,
          columnRelations,
        })
          .then(async ({ data, totalRows = 0 }) => {
            await yieldToMain();
            await applyTablePreviewDataProgressive({
              tabId,
              data,
              totalRows,
              page: 0,
              pageSize,
              setTablePreviews,
              generation: applyGeneration,
              canvasMode: true,
            });
            setTablePreviews((p) => {
              const cur = p[tabId];
              if (!cur) return p;
              return { ...p, [tabId]: { ...cur, sort: sorts } };
            });
          })
          .catch((e) => {
            bumpTablePreviewApplyGeneration(tabId);
            setTablePreviews((p) => {
              const cur = p[tabId];
              if (!cur) return p;
              return {
                ...p,
                [tabId]: {
                  ...cur,
                  loading: false,
                  error: typeof e === "string" ? e : String(e),
                  sort: sorts,
                },
              };
            });
          });

        return { ...prev, [tabId]: { ...existing, loading: true, sort: sorts } };
      });
    },
    [connections, setTablePreviews],
  );

  const commitTabDirty = useCallback(
    async (
      tabId: string,
      snapshot?: {
        dirty: Record<string, Record<string, unknown>>;
        preview: { connId: string; dbName: string; tableName: string };
        colMeta: DbColumnMeta[];
        connection: DbConnectionConfig;
      },
    ) => {
      const tabState = useDbWorkspaceTabStore.getState();
      const dirty = snapshot?.dirty ?? tabState.tabDirtyRows[tabId];
      if (!dirty) return;
      const preview = snapshot?.preview ?? tabState.tablePreviews[tabId];
      if (!preview?.connId || !preview?.dbName || !preview?.tableName) return;
      const connection =
        snapshot?.connection ?? connections.find((c) => c.id === preview.connId);
      if (!connection) return;
      const colMeta = snapshot?.colMeta ?? tabState.tableColumnMeta[tabId];
      if (!colMeta) return;
      const pkCols = colMeta.filter((c) => c.isPk);
      if (pkCols.length === 0) {
        console.error("[db.commit] no primary key found, cannot commit");
        return;
      }
      const connForSchema = { ...connection, database: preview.dbName };
      const tableName = preview.tableName;
      const isRedis = connection.db_type === "redis";
      const isQdrant = isQdrantConnection(connection);
      const sqls: string[] = [];

      if (isQdrant) {
        const pointIds: Array<string | number> = [];
        for (const rowKey of Object.keys(dirty)) {
          if (!rowKey.startsWith(DELETED_ROW_KEY_PREFIX)) {
            console.error("[db.commit] Qdrant MVP 仅支持删除 Points");
            return;
          }
          const originalKey = rowKey.slice(DELETED_ROW_KEY_PREFIX.length);
          const rawId = readRowKeyValue(originalKey, "id");
          const pointId = parseQdrantPointId(rawId);
          if (pointId === null) {
            console.error("[db.commit] Qdrant point id 无效", originalKey);
            return;
          }
          pointIds.push(pointId);
        }
        if (pointIds.length === 0) {
          console.error("[db.commit] no qdrant point ids");
          return;
        }
        setCommittingTabs((prev) => new Set(prev).add(tabId));
        try {
          await qdrantDeletePoints(connForSchema, tableName, pointIds);
          clearTabDirty(tabId);
          if (useDbWorkspaceTabStore.getState().tablePreviews[tabId]) {
            refreshTabPreviewNow(tabId);
          }
        } catch (err) {
          console.error("[db.commit] failed", err);
          throw err;
        } finally {
          setCommittingTabs((prev) => {
            const next = new Set(prev);
            next.delete(tabId);
            return next;
          });
        }
        return;
      }

      if (isRedis) {
        for (const [rowKey, changes] of Object.entries(dirty)) {
          sqls.push(...buildRedisUpdateCommands(tableName, rowKey, pkCols, changes));
        }
        if (sqls.length === 0) {
          console.error("[db.commit] no redis commands generated");
          return;
        }
      } else {
        const pkNames = pkCols.map((c) => c.name);
        const columnTypeByName = new Map(colMeta.map((c) => [c.name, c.type]));
        // BIT / BOOLEAN 列必须按列类型生成字面量，否则 MySQL 会把 '1' 当字节串报 1406
        const escape = (value: unknown, columnName?: string) =>
          escapeSqlLiteral(value, {
            dbType: connection.db_type,
            columnType: columnName ? columnTypeByName.get(columnName) ?? null : null,
          });
        for (const [rowKey, changes] of Object.entries(dirty)) {
          if (rowKey.startsWith(DELETED_ROW_KEY_PREFIX)) {
            const originalKey = rowKey.slice(DELETED_ROW_KEY_PREFIX.length);
            const pkValues = pkNames.map((n) => {
              const v = readRowKeyValue(originalKey, n);
              return v === "" ? `\`${n}\` IS NULL` : `\`${n}\` = ${escape(v, n)}`;
            });
            sqls.push(`DELETE FROM \`${tableName}\` WHERE ${pkValues.join(" AND ")} LIMIT 1`);
            continue;
          }
          if (rowKey.startsWith(NEW_ROW_KEY_PREFIX)) {
            const entries = Object.entries(changes);
            if (entries.length === 0) continue;
            const cols = entries.map(([col]) => `\`${col}\``);
            const vals = entries.map(([col, val]) => escape(val, col));
            sqls.push(
              `INSERT INTO \`${tableName}\` (${cols.join(", ")}) VALUES (${vals.join(", ")})`,
            );
            continue;
          }
          const setClause = Object.entries(changes)
            .map(([col, val]) => `\`${col}\` = ${escape(val, col)}`)
            .join(", ");
          const pkValues = pkNames.map((n) => {
            const v = readRowKeyValue(rowKey, n);
            return v === "" ? `${n} IS NULL` : `${n} = ${escape(v, n)}`;
          });
          sqls.push(`UPDATE \`${tableName}\` SET ${setClause} WHERE ${pkValues.join(" AND ")} LIMIT 1`);
        }
      }
      setCommittingTabs((prev) => new Set(prev).add(tabId));
      try {
        for (const sql of sqls) {
          await invoke("db_execute_query", {
            connection: connForSchema,
            sql,
            runId: makeQueryRunId(),
          });
        }
        clearTabDirty(tabId);
        // Tab 可能已关闭：仅在仍存在预览态时刷新
        if (useDbWorkspaceTabStore.getState().tablePreviews[tabId]) {
          refreshTabPreviewNow(tabId);
        }
      } catch (err) {
        console.error("[db.commit] failed", err);
        throw err;
      } finally {
        setCommittingTabs((prev) => {
          const next = new Set(prev);
          next.delete(tabId);
          return next;
        });
      }
    },
    [connections, clearTabDirty, refreshTabPreviewNow],
  );

  const rollbackTabDirty = useCallback(
    (tabId: string) => {
      clearTabDirty(tabId);
      refreshTabPreviewNow(tabId);
    },
    [clearTabDirty, refreshTabPreviewNow],
  );

  const setTableGridView = useCallback(
    (
      tabId: string,
      patch: Partial<Pick<TablePreviewState, "hiddenColumns" | "transposed" | "columnRelations">>,
    ) => {
      setTablePreviews((prev) => {
        const existing = prev[tabId] ?? createDefaultTablePreviewState();
        return {
          ...prev,
          [tabId]: {
            ...existing,
            ...patch,
            ...(patch.hiddenColumns
              ? { hiddenColumns: [...patch.hiddenColumns] }
              : {}),
            ...(patch.columnRelations !== undefined
              ? {
                  columnRelations: Object.fromEntries(
                    Object.entries(patch.columnRelations).map(([column, relation]) => [
                      column,
                      {
                        tableName: relation.tableName,
                        fieldName: relation.fieldName,
                        ...(relation.displayFieldName?.trim()
                          ? { displayFieldName: relation.displayFieldName.trim() }
                          : {}),
                        ...(relation.alias?.trim() ? { alias: relation.alias.trim() } : {}),
                      },
                    ]),
                  ),
                }
              : {}),
          },
        };
      });
    },
    [],
  );

  const handleRowEdit = useCallback(
    (tabId: string, cellInfo: { rowIndex: number; column: string; row: Record<string, unknown> }) => {
      const pendingKey = cellInfo.row[PENDING_INSERT_ROW_KEY];
      setRowEdit({
        tabId,
        column: cellInfo.column,
        row: cellInfo.row,
        isNewRow: typeof pendingKey === "string",
      });
    },
    [],
  );

  const handleRowPaste = useCallback(
    (tabId: string, payload: { values: Record<string, unknown> }) => {
      const colMeta = useDbWorkspaceTabStore.getState().tableColumnMeta[tabId];
      if (!colMeta?.length) return;
      const pkCols = colMeta.filter((c) => c.isPk);
      const pkCount = pkCols.length;
      const rowKey = `${NEW_ROW_KEY_PREFIX}${crypto.randomUUID()}`;
      const changes: Record<string, unknown> = {};

      for (const col of colMeta) {
        if (isAutoIncrementColumn(col, pkCount)) {
          continue;
        }
        const raw = payload.values[col.name];
        if (raw === undefined) continue;
        if (col.isPk && (raw === null || raw === "")) continue;
        changes[col.name] = raw;
      }

      if (Object.keys(changes).length === 0) return;

      setTabDirtyRows((prev) => {
        const cur = { ...(prev[tabId] ?? {}) };
        cur[rowKey] = changes;
        return { ...prev, [tabId]: cur };
      });
    },
    [],
  );

  const handleRowsDelete = useCallback(
    (
      tabId: string,
      rowInfos: Array<{ rowIndex: number; row: Record<string, unknown> }>,
    ): boolean => {
      if (rowInfos.length === 0) return false;
      const colMeta = useDbWorkspaceTabStore.getState().tableColumnMeta[tabId];
      if (!colMeta?.length) {
        showToast(t("database.results.deleteSelectedRowsNoMeta"));
        return false;
      }
      const pkCols = colMeta.filter((c) => c.isPk);
      let marked = 0;
      let skippedNoPk = 0;

      setTabDirtyRows((prev) => {
        const nextDirty = { ...(prev[tabId] ?? {}) };
        marked = 0;
        skippedNoPk = 0;
        for (const { row } of rowInfos) {
          const pendingKey = row[PENDING_INSERT_ROW_KEY];
          if (typeof pendingKey === "string") {
            delete nextDirty[pendingKey];
            marked += 1;
            continue;
          }
          if (pkCols.length === 0) {
            skippedNoPk += 1;
            continue;
          }
          const rowKey = resolvePreviewRowKey(row, pkCols);
          if (!rowKey) {
            skippedNoPk += 1;
            continue;
          }
          delete nextDirty[rowKey];
          nextDirty[`${DELETED_ROW_KEY_PREFIX}${rowKey}`] = {};
          marked += 1;
        }
        if (Object.keys(nextDirty).length === 0) {
          const next = { ...prev };
          delete next[tabId];
          return next;
        }
        return { ...prev, [tabId]: nextDirty };
      });

      if (marked === 0) {
        showToast(
          skippedNoPk > 0
            ? t("database.results.deleteSelectedRowsNoPk")
            : t("database.results.deleteSelectedRowsFailed"),
        );
        return false;
      }
      return true;
    },
    [t, setTabDirtyRows],
  );

  const handleRowNew = useCallback(
    (tabId: string) => {
      const colMeta = useDbWorkspaceTabStore.getState().tableColumnMeta[tabId];
      if (!colMeta?.length) return;
      // 新建行：在预览表底部插入 pending 行，单元格内填写（不再弹表单）
      const rowKey = `${NEW_ROW_KEY_PREFIX}${crypto.randomUUID()}`;
      setTabDirtyRows((prev) => {
        const cur = { ...(prev[tabId] ?? {}) };
        cur[rowKey] = {};
        return { ...prev, [tabId]: cur };
      });
    },
    [setTabDirtyRows],
  );

  const commitCellDirtyChange = useCallback(
    (
      tabId: string,
      column: string,
      row: Record<string, unknown>,
      value: unknown,
    ) => {
      const colMeta = useDbWorkspaceTabStore.getState().tableColumnMeta[tabId];
      if (!colMeta) return;
      const meta = colMeta.find((c) => c.name === column);
      if (!meta) return;

      const pendingKey = row[PENDING_INSERT_ROW_KEY];
      const isPendingInsert = typeof pendingKey === "string";
      const pkCols = colMeta.filter((c) => c.isPk);
      const pkCount = pkCols.length;

      if (meta.isPk) {
        if (!isPendingInsert) return;
        if (isAutoIncrementColumn(meta, pkCount)) return;
      }

      if (typeof pendingKey === "string") {
        setTabDirtyRows((prev) => {
          const cur = { ...(prev[tabId] ?? {}) };
          const rowDirty = { ...(cur[pendingKey] ?? {}) };
          const originalValue = row[column];
          if (isSameCellValue(originalValue, value)) {
            delete rowDirty[column];
          } else if (value === null || value === undefined) {
            rowDirty[column] = null;
          } else {
            rowDirty[column] = value;
          }
          if (Object.keys(rowDirty).length === 0) {
            delete cur[pendingKey];
          } else {
            cur[pendingKey] = rowDirty;
          }
          if (Object.keys(cur).length === 0) {
            const next = { ...prev };
            delete next[tabId];
            return next;
          }
          return { ...prev, [tabId]: cur };
        });
        return;
      }

      if (pkCols.length === 0) return;
      const originalValue = row[column];
      if (isSameCellValue(originalValue, value)) return;

      const rowKey = pkCols
        .map((pk) => `${pk.name}=${row[pk.name] == null ? "" : String(row[pk.name])}`)
        .join("&");

      setTabDirtyRows((prev) => {
        const cur = { ...(prev[tabId] ?? {}) };
        const rowDirty = { ...(cur[rowKey] ?? {}) };
        if (value === null || value === undefined) {
          rowDirty[column] = null;
        } else {
          rowDirty[column] = value;
        }
        if (Object.keys(rowDirty).length === 0) {
          delete cur[rowKey];
        } else {
          cur[rowKey] = rowDirty;
        }
        if (Object.keys(cur).length === 0) {
          const next = { ...prev };
          delete next[tabId];
          return next;
        }
        return { ...prev, [tabId]: cur };
      });
    },
    [],
  );

  const handleCellSetNull = useCallback(
    (
      tabId: string,
      cellInfo: { rowIndex: number; column: string; row: Record<string, unknown> },
    ) => {
      commitCellDirtyChange(tabId, cellInfo.column, cellInfo.row, null);
    },
    [commitCellDirtyChange],
  );

  const handleCellCommit = useCallback(
    (
      tabId: string,
      cellInfo: { rowIndex: number; column: string; row: Record<string, unknown> },
      value: unknown,
    ) => {
      commitCellDirtyChange(tabId, cellInfo.column, cellInfo.row, value);
    },
    [commitCellDirtyChange],
  );

  const handleRowSave = useCallback(
    (changes: Record<string, unknown>) => {
      if (!rowEdit) return;
      const { tabId, row, isNewRow } = rowEdit;
      const colMeta = useDbWorkspaceTabStore.getState().tableColumnMeta[tabId];
      if (!colMeta) {
        setRowEdit(null);
        return;
      }

      if (isNewRow) {
        const pendingKey = row[PENDING_INSERT_ROW_KEY];
        const rowKey =
          typeof pendingKey === "string" ? pendingKey : `${NEW_ROW_KEY_PREFIX}${crypto.randomUUID()}`;
        setTabDirtyRows((prev) => {
          const cur = { ...(prev[tabId] ?? {}) };
          cur[rowKey] = { ...changes };
          return { ...prev, [tabId]: cur };
        });
        setRowEdit(null);
        return;
      }

      const pkCols = colMeta.filter((c) => c.isPk);
      if (pkCols.length === 0) {
        setRowEdit(null);
        return;
      }
      const rowKey = pkCols
        .map((pk) => `${pk.name}=${row[pk.name] == null ? "" : String(row[pk.name])}`)
        .join("&");

      setTabDirtyRows((prev) => {
        const cur = { ...(prev[tabId] ?? {}) };
        const rowDirty = { ...(cur[rowKey] ?? {}) };

        for (const [column, value] of Object.entries(changes)) {
          const meta = colMeta.find((c) => c.name === column);
          if (!meta) continue;
          const originalValue = row[column];
          if (isSameCellValue(originalValue, value)) {
            delete rowDirty[column];
          } else if (value === null || value === undefined) {
            rowDirty[column] = value;
          } else {
            rowDirty[column] = value;
          }
        }

        if (Object.keys(rowDirty).length === 0) {
          delete cur[rowKey];
        } else {
          cur[rowKey] = rowDirty;
        }
        if (Object.keys(cur).length === 0) {
          const next = { ...prev };
          delete next[tabId];
          return next;
        }
        return { ...prev, [tabId]: cur };
      });
      setRowEdit(null);
    },
    [rowEdit],
  );

  return {
    loadTablePreview,
    refreshTablePreview,
    goToPage,
    setTablePageSize,
    setTableFilter,
    clearTabDirty,
    undoTabDirty,
    redoTabDirty,
    refreshTabPreviewNow,
    goToPageNow,
    setTableSort,
    commitTabDirty,
    rollbackTabDirty,
    setTableGridView,
    handleRowEdit,
    handleRowPaste,
    handleRowsDelete,
    handleRowNew,
    commitCellDirtyChange,
    handleCellSetNull,
    handleCellCommit,
    handleRowSave,
  };
}
