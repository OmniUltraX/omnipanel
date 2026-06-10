import { useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { SidebarWorkspace } from "../../components/ui/SidebarWorkspace";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { SchemaBrowser, type SchemaTableSelection } from "./SchemaBrowser";
import { ConnectionDialog } from "./ConnectionDialog";
import { ContextMenu } from "../../components/ui/ContextMenu";
import { buildTabCloseMenuItems, type TabContextMenuAction } from "../../components/ui/contextMenuItems";
import { useActionStore } from "../../stores/actionStore";
import { useDbGroupStore } from "../../stores/dbGroupStore";
import { useDbSchemaFilterStore } from "../../stores/dbSchemaFilterStore";
import { getVisibleNames, mergeFilter } from "./DatabaseFilterDialog";
import { useTopbarTabs } from "../../hooks/useTopbarTabs";
import { useI18n } from "../../i18n";
import { quickInput } from "../../lib/quickInput";
import { isSqlMonacoEditorFocused, sqlAtOffset } from "./lsp/sqlStatement";
import {
  connectionMatchesGroup,
  countTable,
  fetchTableDdl,
  introspectSchema,
  introspectTable,
  listConnections,
  listDatabases,
  previewTable,
  type DbColumnMeta,
  type DbConnectionConfig,
} from "./api";
import { buildDatabaseSchema, introspectToTableSchemas } from "./lsp/sqlCompletion";
import { toCsv } from "./csvExport";
import type { DatabaseSchema } from "./types";
import {
  makeSqlTabId,
  makeSqlTabLabel,
  makeTableTabLabel,
  type SqlWorkspaceTab,
} from "./workspaceTabs";
import { CellEditorDialog } from "./cell_editor";
import { SubWindow } from "../../components/ui/SubWindow";
import { useDbToolboxStore } from "../../stores/dbToolboxStore";
import { DatabaseToolbox } from "./toolbox/DatabaseToolbox";
import {
  createDefaultSqlTabState,
  createDefaultTablePreviewState,
  rowsToRecord,
  tabModeToEditorOpenMode,
  type SqlTabState,
  type TablePreviewState,
  type QueryResult,
} from "./dbWorkspaceState";
import { DbPanelSurface } from "./DbPanelSurface";
import { DockableWorkspace } from "../../components/dock";
import { DbWorkspaceProvider, type DbWorkspaceContextValue } from "../../contexts/DbWorkspaceContext";
import { useDbDockLayoutStore } from "../../stores/dbDockLayoutStore";

const INITIAL_SQL_TAB_ID = makeSqlTabId();
const INITIAL_SQL_TAB: SqlWorkspaceTab = {
  id: INITIAL_SQL_TAB_ID,
  kind: "sql",
  label: makeSqlTabLabel(1),
};


/** 把行主键拼成的字符串（"col=val&col=val"）解析回单列值，rowKey 中空字符串表示 NULL。 */
function readRowKeyValue(rowKey: string, colName: string): string {
  for (const part of rowKey.split("&")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq) === colName) {
      return part.slice(eq + 1);
    }
  }
  return "";
}

export function DatabasePanel() {
  const { t } = useI18n();
  const enqueueAction = useActionStore((s) => s.enqueueAction);
  const groups = useDbGroupStore((s) => s.groups);
  const activeGroupId = useDbGroupStore((s) => s.activeGroupId);
  const setActiveGroupId = useDbGroupStore((s) => s.setActiveGroupId);
  const addGroup = useDbGroupStore((s) => s.addGroup);
  const getGroupName = useDbGroupStore((s) => s.getGroupName);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [schemaRefreshToken, setSchemaRefreshToken] = useState(0);

  const [connections, setConnections] = useState<DbConnectionConfig[]>([]);
  const [activeConnId, setActiveConnId] = useState<string | null>(null);
  const [sqlTabStates, setSqlTabStates] = useState<Record<string, SqlTabState>>(() => ({
    [INITIAL_SQL_TAB_ID]: createDefaultSqlTabState(),
  }));

  const [workspaceTabs, setWorkspaceTabs] = useState<SqlWorkspaceTab[]>([INITIAL_SQL_TAB]);
  const [activeWorkspaceTabId, setActiveWorkspaceTabId] = useState(INITIAL_SQL_TAB_ID);
  const [tablePreviews, setTablePreviews] = useState<Record<string, TablePreviewState>>({});
  const [activeTableKey, setActiveTableKey] = useState<string | null>(null);
  const [tableColumnMeta, setTableColumnMeta] = useState<Record<string, DbColumnMeta[]>>({});
  const [tabModes, setTabModes] = useState<Record<string, "data" | "sql">>({});
  const [databasesByConnId, setDatabasesByConnId] = useState<Record<string, string[]>>({});
  const [schemaByKey, setSchemaByKey] = useState<Record<string, DatabaseSchema>>({});
  const [schemaLoadingKey, setSchemaLoadingKey] = useState<string | null>(null);
  const [cellEdit, setCellEdit] = useState<{
    tabId: string;
    column: string;
    row: Record<string, unknown>;
  } | null>(null);
  /** 每个 tab 的「未提交修改」：行键 -> {列名: 新值}。提交或回滚后清空对应 tab。 */
  const [tabDirtyRows, setTabDirtyRows] = useState<
    Record<string, Record<string, Record<string, unknown>>>
  >({});
  const [committingTabs, setCommittingTabs] = useState<Set<string>>(() => new Set());
  const [pendingTabAction, setPendingTabAction] = useState<
    | {
        kind: "refresh" | "page" | "close";
        tabId: string;
        page?: number;
      }
    | null
  >(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tabId: string; index: number } | null>(null);
  const [tableCtxMenu, setTableCtxMenu] = useState<
    | {
        x: number;
        y: number;
        selection: SchemaTableSelection;
      }
    | null
  >(null);
  const toolboxOpen = useDbToolboxStore((s) => s.open);
  const setToolboxOpen = useDbToolboxStore((s) => s.setOpen);
  const dockLayout = useDbDockLayoutStore((s) => s.savedLayout);
  const setDockLayout = useDbDockLayoutStore((s) => s.setSavedLayout);

  const activeGroupName = useMemo(
    () => getGroupName(activeGroupId),
    [activeGroupId, getGroupName, groups],
  );

  const groupConnections = useMemo(
    () => connections.filter((conn) => connectionMatchesGroup(conn, activeGroupName)),
    [connections, activeGroupName],
  );

  const activeConn = useMemo(
    () => groupConnections.find((c) => c.id === activeConnId) ?? groupConnections[0] ?? null,
    [groupConnections, activeConnId],
  );

  const activeWorkspaceTab = useMemo(
    () => workspaceTabs.find((tab) => tab.id === activeWorkspaceTabId) ?? null,
    [workspaceTabs, activeWorkspaceTabId],
  );

  const updateSqlTabState = useCallback((tabId: string, patch: Partial<SqlTabState>) => {
    setSqlTabStates((prev) => ({
      ...prev,
      [tabId]: { ...(prev[tabId] ?? createDefaultSqlTabState()), ...patch },
    }));
  }, []);

  const refreshConnections = useCallback(async () => {
    try {
      const list = await listConnections();
      setConnections(list);
      setActiveConnId((prev) => {
        if (prev && list.some((item) => item.id === prev)) {
          return prev;
        }
        const inGroup = list.find((item) => connectionMatchesGroup(item, activeGroupName));
        return inGroup?.id ?? list[0]?.id ?? null;
      });
    } catch {
      // 非 Tauri 环境（纯前端 dev）忽略。
    }
  }, [activeGroupName]);

  useEffect(() => {
    void refreshConnections();
  }, [refreshConnections, schemaRefreshToken]);

  useEffect(() => {
    setActiveConnId((prev) => {
      if (prev && groupConnections.some((item) => item.id === prev)) {
        return prev;
      }
      return groupConnections[0]?.id ?? null;
    });
  }, [activeGroupId, groupConnections]);

  const activeSqlTabId =
    activeWorkspaceTab?.kind === "sql" ? activeWorkspaceTab.id : null;
  const activeSqlTabState = activeSqlTabId
    ? (sqlTabStates[activeSqlTabId] ?? createDefaultSqlTabState())
    : null;
  const activeSqlDatabase = activeSqlTabState?.database ?? "";

  const connectionForSql = useMemo(() => {
    if (!activeConn) {
      return null;
    }
    if (!activeSqlDatabase.trim()) {
      return activeConn;
    }
    return { ...activeConn, database: activeSqlDatabase };
  }, [activeConn, activeSqlDatabase]);

  const databaseFilters = useDbSchemaFilterStore((s) => s.databaseFilters);
  const hydrateSchemaFilters = useDbSchemaFilterStore((s) => s.hydrate);
  const setDatabaseFilters = useDbSchemaFilterStore((s) => s.setDatabaseFilters);
  const filtersHydrated = useDbSchemaFilterStore((s) => s.hydrated);

  const allDatabasesForActiveConn = activeConn
    ? (databasesByConnId[activeConn.id] ?? [])
    : [];

  const databasesForActiveConn = useMemo(() => {
    if (!activeConn) {
      return [];
    }
    return getVisibleNames(allDatabasesForActiveConn, databaseFilters[activeConn.id]);
  }, [activeConn, allDatabasesForActiveConn, databaseFilters]);

  useEffect(() => {
    if (!filtersHydrated) {
      void hydrateSchemaFilters();
    }
  }, [filtersHydrated, hydrateSchemaFilters, schemaRefreshToken]);

  const sqlCompletionSchemas = useMemo((): DatabaseSchema[] => {
    if (!activeConn || !activeSqlDatabase.trim()) {
      return [];
    }
    const key = `${activeConn.id}:${activeSqlDatabase}`;
    const cached = schemaByKey[key];
    if (cached) {
      return [cached];
    }
    return [buildDatabaseSchema(activeSqlDatabase, [])];
  }, [activeConn, activeSqlDatabase, schemaByKey]);

  useEffect(() => {
    if (!activeConn) {
      return;
    }
    if (databasesByConnId[activeConn.id]) {
      return;
    }
    let cancelled = false;
    void listDatabases(activeConn)
      .then((names) => {
        if (!cancelled) {
          setDatabasesByConnId((prev) => ({ ...prev, [activeConn.id]: names }));
          setDatabaseFilters((prev) => ({
            ...prev,
            [activeConn.id]: mergeFilter(prev[activeConn.id], names),
          }));
        }
      })
      .catch(() => {
        if (!cancelled) {
          const fallback = activeConn.database.trim() ? [activeConn.database] : [];
          setDatabasesByConnId((prev) => ({ ...prev, [activeConn.id]: fallback }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeConn, databasesByConnId]);

  useEffect(() => {
    if (!activeSqlTabId || !activeConn || databasesForActiveConn.length === 0) {
      return;
    }
    const tabState = sqlTabStates[activeSqlTabId];
    const current = tabState?.database.trim() ?? "";
    const preset = activeConn.database.trim();
    const pick =
      current && databasesForActiveConn.includes(current)
        ? current
        : preset && databasesForActiveConn.includes(preset)
          ? preset
          : databasesForActiveConn[0];
    if (pick && pick !== current) {
      updateSqlTabState(activeSqlTabId, { database: pick });
    }
  }, [
    activeSqlTabId,
    activeConn,
    databasesForActiveConn,
    sqlTabStates,
    updateSqlTabState,
  ]);

  useEffect(() => {
    if (!activeConn || !activeSqlDatabase.trim()) {
      return;
    }
    const key = `${activeConn.id}:${activeSqlDatabase}`;
    if (schemaByKey[key]) {
      return;
    }
    let cancelled = false;
    setSchemaLoadingKey(key);
    void introspectSchema(activeConn, activeSqlDatabase)
      .then((result) => {
        if (cancelled) {
          return;
        }
        const tables = introspectToTableSchemas(result.tables);
        setSchemaByKey((prev) => ({
          ...prev,
          [key]: buildDatabaseSchema(result.database, tables),
        }));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) {
          setSchemaLoadingKey((current) => (current === key ? null : current));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeConn, activeSqlDatabase, schemaByKey]);

  const loadTablePreview = useCallback(
    async (tabId: string, connection: DbConnectionConfig, dbName: string, tableName: string) => {
      const connForSchema = { ...connection, database: dbName };
      const defaultState = createDefaultTablePreviewState();
      const prev = defaultState;

      // 1) 查询总数
      setTablePreviews((prevMap) => ({
        ...prevMap,
        [tabId]: { ...(prevMap[tabId] ?? defaultState), loading: true, error: null },
      }));
      let totalRows = 0;
      try {
        totalRows = await countTable(connForSchema, tableName, dbName);
      } catch (e) {
        setTablePreviews((prevMap) => ({
          ...prevMap,
          [tabId]: {
            ...(prevMap[tabId] ?? defaultState),
            loading: false,
            error: typeof e === "string" ? e : String(e),
          },
        }));
        return;
      }

      // 2) 查询当前页数据
      const pageSize = prev.pageSize;
      try {
        const data = await previewTable(connForSchema, tableName, pageSize, 0);
        setTablePreviews((prevMap) => ({
          ...prevMap,
          [tabId]: { ...(prevMap[tabId] ?? defaultState), loading: false, error: null, data, totalRows, page: 0, pageSize },
        }));
      } catch (e) {
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
    [],
  );

  const refreshTablePreview = useCallback(
    (tabId: string, connId: string, dbName: string, tableName: string) => {
      const connection = connections.find((c) => c.id === connId);
      if (!connection) return;
      const connForSchema = { ...connection, database: dbName };

      setTablePreviews((prev) => {
        const existing = prev[tabId] ?? createDefaultTablePreviewState();
        const pageSize = existing.pageSize;
        const page = existing.page;

        Promise.all([
          countTable(connForSchema, tableName, dbName),
          previewTable(connForSchema, tableName, pageSize, page * pageSize),
        ])
          .then(([totalRows, data]) => {
            setTablePreviews((p) => {
              const cur = p[tabId];
              if (!cur) return p;
              return { ...p, [tabId]: { ...cur, loading: false, error: null, data, totalRows } };
            });
          })
          .catch((e) => {
            setTablePreviews((p) => {
              const cur = p[tabId];
              if (!cur) return p;
              return { ...p, [tabId]: { ...cur, loading: false, error: typeof e === "string" ? e : String(e) } };
            });
          });

        return { ...prev, [tabId]: { ...existing, loading: true } };
      });
    },
    [connections],
  );

  const goToPage = useCallback(
    (tabId: string, connId: string, dbName: string, tableName: string, page: number) => {
      const connection = connections.find((c) => c.id === connId);
      if (!connection) return;
      const connForSchema = { ...connection, database: dbName };
      setTablePreviews((prev) => {
        const existing = prev[tabId] ?? createDefaultTablePreviewState();
        const pageSize = existing.pageSize;

        previewTable(connForSchema, tableName, pageSize, page * pageSize)
          .then((data) => {
            setTablePreviews((p) => {
              const cur = p[tabId];
              if (!cur) return p;
              return { ...p, [tabId]: { ...cur, loading: false, data, page } };
            });
          })
          .catch((e) => {
            setTablePreviews((p) => {
              const cur = p[tabId];
              if (!cur) return p;
              return { ...p, [tabId]: { ...cur, loading: false, error: typeof e === "string" ? e : String(e) } };
            });
          });

        return { ...prev, [tabId]: { ...existing, loading: true } };
      });
    },
    [connections],
  );

  const clearTabDirty = useCallback((tabId: string) => {
    setTabDirtyRows((prev) => {
      if (!(tabId in prev)) return prev;
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
  }, []);

  const refreshTabPreviewNow = useCallback(
    (tabId: string) => {
      const preview = tablePreviews[tabId];
      if (!preview?.connId || !preview?.dbName || !preview?.tableName) return;
      refreshTablePreview(tabId, preview.connId, preview.dbName, preview.tableName);
    },
    [tablePreviews, refreshTablePreview],
  );

  const goToPageNow = useCallback(
    (tabId: string, page: number) => {
      const preview = tablePreviews[tabId];
      if (!preview?.connId || !preview?.dbName || !preview?.tableName) return;
      goToPage(tabId, preview.connId, preview.dbName, preview.tableName, page);
    },
    [tablePreviews, goToPage],
  );

  const commitTabDirty = useCallback(
    async (tabId: string) => {
      const dirty = tabDirtyRows[tabId];
      if (!dirty) return;
      const preview = tablePreviews[tabId];
      if (!preview?.connId || !preview?.dbName || !preview?.tableName) return;
      const connection = connections.find((c) => c.id === preview.connId);
      if (!connection) return;
      const colMeta = tableColumnMeta[tabId];
      if (!colMeta) return;
      const pkCols = colMeta.filter((c) => c.isPk);
      if (pkCols.length === 0) {
        console.error("[db.commit] no primary key found, cannot commit");
        return;
      }
      const connForSchema = { ...connection, database: preview.dbName };
      const tableName = preview.tableName;
      const pkNames = pkCols.map((c) => c.name);
      const escape = (v: unknown): string => {
        if (v === null || v === undefined) return "NULL";
        if (typeof v === "number") return String(v);
        return `'${String(v).replace(/'/g, "\\'")}'`;
      };
      const sqls: string[] = [];
      for (const [rowKey, changes] of Object.entries(dirty)) {
        const setClause = Object.entries(changes)
          .map(([col, val]) => `\`${col}\` = ${escape(val)}`)
          .join(", ");
        const pkValues = pkNames.map((n) => {
          const v = readRowKeyValue(rowKey, n);
          return v === "" ? `${n} IS NULL` : `${n} = ${escape(v)}`;
        });
        sqls.push(`UPDATE \`${tableName}\` SET ${setClause} WHERE ${pkValues.join(" AND ")} LIMIT 1`);
      }
      setCommittingTabs((prev) => new Set(prev).add(tabId));
      try {
        for (const sql of sqls) {
          await invoke("db_execute_query", { connection: connForSchema, sql });
        }
        clearTabDirty(tabId);
        refreshTabPreviewNow(tabId);
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
    [tabDirtyRows, tablePreviews, connections, tableColumnMeta, clearTabDirty, refreshTabPreviewNow],
  );

  const rollbackTabDirty = useCallback(
    (tabId: string) => {
      clearTabDirty(tabId);
      refreshTabPreviewNow(tabId);
    },
    [clearTabDirty, refreshTabPreviewNow],
  );

  const closeWorkspaceTab = useCallback((tabId: string) => {
    setWorkspaceTabs((prev) => {
      const idx = prev.findIndex((tab) => tab.id === tabId);
      const next = prev.filter((tab) => tab.id !== tabId);
      setActiveWorkspaceTabId((current) => {
        if (current !== tabId) {
          return current;
        }
        const fallback = next[Math.min(idx, Math.max(0, next.length - 1))];
        return fallback?.id ?? "";
      });
      return next;
    });
    setSqlTabStates((prev) => {
      if (!(tabId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
    setTablePreviews((prev) => {
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
    setTableColumnMeta((prev) => {
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
    setTabModes((prev) => {
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
    setTabDirtyRows((prev) => {
      if (!(tabId in prev)) return prev;
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
    setCommittingTabs((prev) => {
      if (!prev.has(tabId)) return prev;
      const next = new Set(prev);
      next.delete(tabId);
      return next;
    });
  }, []);

  const hasDirty = useCallback(
    (tabId: string) => Object.keys(tabDirtyRows[tabId] ?? {}).length > 0,
    [tabDirtyRows],
  );

  const requestTabAction = useCallback(
    (action: { kind: "refresh" | "page" | "close"; tabId: string; page?: number }) => {
      if (hasDirty(action.tabId)) {
        setPendingTabAction(action);
        return;
      }
      executeTabAction(action);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasDirty],
  );

  const executeTabAction = useCallback(
    (action: { kind: "refresh" | "page" | "close"; tabId: string; page?: number }) => {
      if (action.kind === "refresh") {
        refreshTabPreviewNow(action.tabId);
      } else if (action.kind === "page") {
        goToPageNow(action.tabId, action.page ?? 0);
      } else {
        closeWorkspaceTab(action.tabId);
      }
    },
    [refreshTabPreviewNow, goToPageNow, closeWorkspaceTab],
  );

  const confirmPendingCommit = useCallback(async () => {
    if (!pendingTabAction) return;
    const tabId = pendingTabAction.tabId;
    setPendingTabAction(null);
    try {
      await commitTabDirty(tabId);
    } catch {
      // 提交失败时不清空 dirty，提示用户去处理
      return;
    }
    executeTabAction(pendingTabAction);
  }, [pendingTabAction, commitTabDirty, executeTabAction]);

  const cancelPendingCommit = useCallback(() => {
    if (!pendingTabAction) return;
    setPendingTabAction(null);
    executeTabAction(pendingTabAction);
  }, [pendingTabAction, executeTabAction]);

  const handleCellEdit = useCallback(
    (tabId: string, cellInfo: { rowIndex: number; column: string; row: Record<string, unknown> }) => {
      setCellEdit({ tabId, column: cellInfo.column, row: cellInfo.row });
    },
    [],
  );

  const handleCellSave = useCallback(
    (value: unknown) => {
      if (!cellEdit) return;
      const { tabId, column, row } = cellEdit;
      const colMeta = tableColumnMeta[tabId];
      if (!colMeta) {
        setCellEdit(null);
        return;
      }
      const pkCols = colMeta.filter((c) => c.isPk);
      if (pkCols.length === 0) {
        setCellEdit(null);
        return;
      }
      const originalValue = row[column];
      const same =
        originalValue === value ||
        (originalValue == null && value === "") ||
        (originalValue === "" && value == null) ||
        (typeof originalValue === "number" &&
          typeof value === "string" &&
          String(originalValue) === value);
      if (same) {
        setCellEdit(null);
        return;
      }
      const rowKey = pkCols
        .map((pk) => `${pk.name}=${row[pk.name] == null ? "" : String(row[pk.name])}`)
        .join("&");
      setTabDirtyRows((prev) => {
        const cur = { ...(prev[tabId] ?? {}) };
        const rowDirty = { ...(cur[rowKey] ?? {}) };
        if (value === null || value === undefined) {
          delete rowDirty[column];
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
      setCellEdit(null);
    },
    [cellEdit, tableColumnMeta],
  );

  const handleContextTable = useCallback(
    (selection: SchemaTableSelection, event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setTableCtxMenu({ x: event.clientX, y: event.clientY, selection });
    },
    [],
  );

  async function writeToClipboard(text: string): Promise<boolean> {
    const clip = navigator.clipboard;
    if (clip && typeof clip.writeText === "function") {
      try {
        await clip.writeText(text);
        return true;
      } catch (err) {
        console.error("[clipboard] writeText failed, falling back", err);
      }
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (err) {
      console.error("[clipboard] execCommand failed", err);
    }
    document.body.removeChild(ta);
    return ok;
  }

  const copyNameForCurrentTable = useCallback(() => {
    const ctx = tableCtxMenu;
    if (!ctx) return;
    void writeToClipboard(`\`${ctx.selection.dbName}\`.\`${ctx.selection.tableName}\``);
  }, [tableCtxMenu]);

  const exportPreviewToCsv = useCallback(
    async (tabId: string) => {
      const preview = tablePreviews[tabId];
      if (!preview?.data) return;
      const { columns, rows } = preview.data;
      const csv = toCsv(columns, rows);
      const baseName = `${preview.dbName ?? "export"}_${preview.tableName ?? "result"}`;
      const defaultName = `${baseName}_page${preview.page + 1}.csv`;
      const filePath = await save({
        title: t("database.results.exportCsv"),
        defaultPath: defaultName,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!filePath) return;
      await invoke("write_text_file", { path: filePath, contents: csv });
    },
    [tablePreviews, t],
  );

  const copyPreviewToClipboard = useCallback(
    async (tabId: string) => {
      const preview = tablePreviews[tabId];
      if (!preview?.data) return;
      const { columns, rows } = preview.data;
      await writeToClipboard(toCsv(columns, rows));
    },
    [tablePreviews],
  );

  const [exportMenu, setExportMenu] = useState<
    { x: number; y: number; tabId: string } | null
  >(null);
  const buildExportMenuItems = useCallback(() => {
    const clipboardIcon = (
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <rect x="5" y="5" width="9" height="9" rx="1.5" />
        <path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H11" />
      </svg>
    );
    const fileIcon = (
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <path d="M3 2.5h7l3 3v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z" />
        <path d="M10 2.5V6h3" />
      </svg>
    );
    return [
      {
        id: "export-clipboard",
        label: t("database.results.exportToClipboard"),
        icon: clipboardIcon,
        onClick: () => {
          const tabId = exportMenu?.tabId;
          if (!tabId) return;
          void copyPreviewToClipboard(tabId);
        },
      },
      {
        id: "export-file",
        label: t("database.results.exportToFile"),
        icon: fileIcon,
        onClick: () => {
          const tabId = exportMenu?.tabId;
          if (!tabId) return;
          void exportPreviewToCsv(tabId);
        },
      },
    ];
  }, [copyPreviewToClipboard, exportPreviewToCsv, exportMenu?.tabId, t]);

  const copyDdlForCurrentTable = useCallback(() => {
    const ctx = tableCtxMenu;
    if (!ctx) return;
    fetchTableDdl(ctx.selection.connection, ctx.selection.dbName, ctx.selection.tableName)
      .then((ddl) => writeToClipboard(ddl))
      .catch((err) => console.error("[db.copyDdl] fetchTableDdl failed", err));
  }, [tableCtxMenu]);

  const buildTableContextMenuItems = useCallback(() => {
    const copyIcon = (
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <rect x="5" y="5" width="9" height="9" rx="1.5" />
        <path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H11" />
      </svg>
    );
    return [
      {
        id: "copy",
        label: t("database.contextMenu.copy"),
        icon: copyIcon,
        children: [
          {
            id: "copy-name",
            label: t("database.contextMenu.copyName"),
            onClick: copyNameForCurrentTable,
          },
          {
            id: "copy-ddl",
            label: t("database.contextMenu.copyDdl"),
            onClick: copyDdlForCurrentTable,
          },
          {
            id: "copy-data",
            label: t("database.contextMenu.copyData"),
            disabled: true,
          },
        ],
      },
    ];
  }, [t, copyDdlForCurrentTable, copyNameForCurrentTable]);

  const handleSelectTable = useCallback(
    (selection: SchemaTableSelection) => {
      const tableKey = `tbl:${selection.connId}:${selection.dbName}:${selection.tableName}`;
      const tabId = makeSqlTabId();
      setActiveTableKey(tableKey);
      setActiveConnId(selection.connId);

      // Create a SQL tab with collapsed editor for table preview
      setWorkspaceTabs((prev) => {
        const tab: SqlWorkspaceTab = {
          id: tabId,
          kind: "sql",
          label: makeTableTabLabel(selection.dbName, selection.tableName),
        };
        return [...prev, tab];
      });
      setActiveWorkspaceTabId(tabId);
      setTabModes((prev) => ({ ...prev, [tabId]: "data" }));

      // Set the database for the SQL tab
      setSqlTabStates((prev) => ({
        ...prev,
        [tabId]: { ...createDefaultSqlTabState(selection.dbName), sql: `SELECT * FROM \`${selection.tableName}\` LIMIT 100;` },
      }));

      // Initialize preview metadata (before loadTablePreview's async updates)
      setTablePreviews((prev) => ({
        ...prev,
        [tabId]: { ...createDefaultTablePreviewState(), loading: true, connId: selection.connId, dbName: selection.dbName, tableName: selection.tableName },
      }));

      void loadTablePreview(
        tabId,
        selection.connection,
        selection.dbName,
        selection.tableName,
      );
      // Fetch column metadata for cell editing
      void introspectTable(selection.connection, selection.dbName, selection.tableName)
        .then((schema) => {
          setTableColumnMeta((prev) => ({ ...prev, [tabId]: schema.columns }));
        })
        .catch(() => {});
    },
    [loadTablePreview],
  );

  const openNewSqlTab = useCallback(() => {
    const tabId = makeSqlTabId();
    const sqlTabCount = workspaceTabs.length + 1;
    const tab: SqlWorkspaceTab = {
      id: tabId,
      kind: "sql",
      label: makeSqlTabLabel(sqlTabCount),
    };
    const presetDb = activeConn?.database.trim() ?? "";
    setSqlTabStates((prev) => ({
      ...prev,
      [tabId]: createDefaultSqlTabState(presetDb),
    }));
    setWorkspaceTabs((prev) => [...prev, tab]);
    setActiveWorkspaceTabId(tabId);
    setTabModes((prev) => ({ ...prev, [tabId]: "sql" }));
  }, [activeConn?.database, workspaceTabs]);

  const renameWorkspaceTab = useCallback((tabId: string, label: string) => {
    const nextLabel = label.trim();
    if (!nextLabel) return;
    setWorkspaceTabs((prev) =>
      prev.map((tab) => (tab.id === tabId ? { ...tab, label: nextLabel } : tab)),
    );
  }, []);

  const handleRenameTab = useCallback(
    async (tabId: string) => {
      const tab = workspaceTabs.find((item) => item.id === tabId);
      if (!tab) return;

      const name = await quickInput({
        title: t("database.workspace.renameTabTitle"),
        subtitle: t("shell.topbar.rename"),
        placeholder: t("database.workspace.renameTabPlaceholder"),
        defaultValue: tab.label,
        validate: (value) => {
          if (!value.trim()) {
            return t("database.workspace.renameTabRequired");
          }
          return null;
        },
      });

      if (name) {
        renameWorkspaceTab(tabId, name);
      }
    },
    [workspaceTabs, t, renameWorkspaceTab],
  );

  const handleContextAction = useCallback(
    (action: TabContextMenuAction) => {
      if (!ctxMenu) return;
      const idx = ctxMenu.index;
      const tabList = workspaceTabs;
      const { tabId } = ctxMenu;

      if (action === "rename") {
        setCtxMenu(null);
        void handleRenameTab(tabId);
        return;
      }

      if (action === "close") {
        closeWorkspaceTab(tabId);
      } else if (action === "closeLeft") {
        for (let i = idx - 1; i >= 0; i--) closeWorkspaceTab(tabList[i].id);
      } else if (action === "closeRight") {
        for (let i = tabList.length - 1; i > idx; i--) closeWorkspaceTab(tabList[i].id);
      } else if (action === "closeOthers") {
        for (let i = tabList.length - 1; i >= 0; i--) {
          if (i !== idx) closeWorkspaceTab(tabList[i].id);
        }
      } else if (action === "closeAll") {
        for (let i = tabList.length - 1; i >= 0; i--) closeWorkspaceTab(tabList[i].id);
      }
      setCtxMenu(null);
    },
    [ctxMenu, workspaceTabs, closeWorkspaceTab, handleRenameTab],
  );


  const handleCreateGroup = useCallback(async () => {
    const name = await quickInput({
      title: t("database.groups.createTitle"),
      subtitle: t("database.groups.nameLabel"),
      placeholder: t("database.groups.namePlaceholder"),
      validate: (value) => {
        if (!value.trim()) {
          return t("database.groups.nameRequired");
        }
        if (groups.some((group) => group.name === value.trim())) {
          return t("database.groups.duplicate");
        }
        return null;
      },
    });
    if (name) {
      addGroup(name);
    }
  }, [addGroup, groups, t]);

  const topbarTabs = useMemo(
    () =>
      groups.map((group) => ({
        id: group.id,
        label: group.name,
        active: group.id === activeGroupId,
      })),
    [groups, activeGroupId],
  );

  useTopbarTabs(
    topbarTabs,
    {
      onSelect: (id) => setActiveGroupId(id),
      onAdd: () => void handleCreateGroup(),
    },
    { mode: "connection", showAddTab: true, addTabTitle: t("database.groups.new") },
  );

  const runQuery = useCallback(async (sqlOverride?: string, tabIdOverride?: string) => {
    const tabId = tabIdOverride ?? activeWorkspaceTab?.id;
    const tab = tabId ? workspaceTabs.find((t) => t.id === tabId) : null;
    if (!tab || tab.kind !== "sql") {
      return;
    }
    const resolvedTabId = tab.id;
    const tabState = sqlTabStates[resolvedTabId] ?? createDefaultSqlTabState();
    const conn = connectionForSql;
    const sql = (sqlOverride ?? tabState.sql).trim();
    if (!conn) {
      updateSqlTabState(resolvedTabId, { error: t("database.results.noConnection") });
      return;
    }
    if (!tabState.database.trim()) {
      updateSqlTabState(resolvedTabId, { error: t("database.workspace.selectDatabase") });
      return;
    }
    if (!sql) {
      updateSqlTabState(resolvedTabId, { error: t("database.results.emptySql") });
      return;
    }
    updateSqlTabState(resolvedTabId, { running: true, error: null });
    enqueueAction({
      type: "sql",
      title: t("database.actions.runQuery"),
      description: `${conn.name} · ${t("database.actions.runQueryDesc")}`,
      command: sql,
      resourceId: conn.id,
      source: "用户",
    });
    const started = performance.now();
    try {
      const res = await invoke<QueryResult>("db_execute_query", {
        connection: conn,
        sql,
      });
      updateSqlTabState(resolvedTabId, {
        result: res,
        elapsed: Math.round(performance.now() - started),
        running: false,
      });
    } catch (e) {
      updateSqlTabState(resolvedTabId, {
        result: null,
        error: typeof e === "string" ? e : JSON.stringify(e),
        running: false,
      });
    }
  }, [
    connectionForSql,
    activeWorkspaceTab,
    workspaceTabs,
    enqueueAction,
    sqlTabStates,
    t,
    updateSqlTabState,
  ]);

  // 表预览（data）模式：编辑器常折叠且无焦点，在此统一处理 ⌘/Ctrl+Enter。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (!(e.metaKey || e.ctrlKey) || e.key !== "Enter" || e.shiftKey || e.altKey) {
        return;
      }
      if (isSqlMonacoEditorFocused()) return;

      const tabId = activeWorkspaceTabId;
      if (!tabId) return;
      const tabState = sqlTabStates[tabId];
      if (!tabState) return;

      const statement = sqlAtOffset(tabState.sql, tabState.cursorOffset);
      if (!statement) return;

      e.preventDefault();
      e.stopPropagation();
      void runQuery(statement, tabId);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [activeWorkspaceTabId, sqlTabStates, runQuery]);

  const ctxValue = useMemo<DbWorkspaceContextValue>(() => ({
    tabs: workspaceTabs,
    activeTabId: activeWorkspaceTabId,
    setActiveTabId: setActiveWorkspaceTabId,
    closeTab: (tabId) => requestTabAction({ kind: "close", tabId }),
    runQuery,
    updateSqlTabState,
    refreshTablePreview,
    goToPage,
    requestTabAction,
    handleCellEdit,
    sqlTabStates,
    tablePreviews,
    tableColumnMeta,
    tabModes,
    setTabMode: (id, mode) => setTabModes((prev) => ({ ...prev, [id]: mode })),
    tabDirtyRows,
    committingTabs,
    commitTabDirty,
    openExportMenu: (x: number, y: number, tabId: string) => setExportMenu({ x, y, tabId }),
    activeConn,
    groupConnections,
    databasesByConnId,
    databasesForActiveConn,
    schemaByKey,
    schemaLoadingKey,
    setActiveConnId,
    sqlCompletionSchemas,
    connectionForSql,
    rowsToRecord,
    tabModeToEditorOpenMode,
  }), [
    workspaceTabs, activeWorkspaceTabId, setActiveWorkspaceTabId, requestTabAction,
    runQuery, updateSqlTabState, refreshTablePreview, goToPage, handleCellEdit,
    sqlTabStates, tablePreviews, tableColumnMeta, tabModes, tabDirtyRows, committingTabs,
    commitTabDirty, activeConn, groupConnections, databasesByConnId, databasesForActiveConn,
    schemaByKey, schemaLoadingKey, setActiveConnId, sqlCompletionSchemas, connectionForSql,
  ]);

  return (
    <DbWorkspaceProvider value={ctxValue}>
      <SidebarWorkspace
        preset="schema"
        sidebarMinPx={280}
        sidebar={
          <SchemaBrowser
            onCreateConnection={() => setDialogOpen(true)}
            onNewQuery={openNewSqlTab}
            onSelectTable={handleSelectTable}
            onContextTable={handleContextTable}
            activeTableKey={activeTableKey}
            refreshToken={schemaRefreshToken}
            groupFilter={activeGroupName}
          />
        }
      >
        <DockableWorkspace
          className="db-workspace"
          tabs={workspaceTabs.map((tab) => ({ id: tab.id, label: tab.label }))}
          activeTabId={activeWorkspaceTabId}
          onActiveTabChange={setActiveWorkspaceTabId}
          onCloseTab={(tabId) => requestTabAction({ kind: "close", tabId })}
          savedLayout={dockLayout}
          onSavedLayoutChange={setDockLayout}
          emptyContent={t("database.workspace.emptyTabs")}
          renderPanel={(tabId) => {
            const tab = workspaceTabs.find((item) => item.id === tabId);
            if (!tab) return null;
            return (
              <div className="db-workspace-pane db-dock-pane">
                <DbPanelSurface tab={tab} />
              </div>
            );
          }}
          onTabContextMenu={(_event, tabId, index) => {
            setCtxMenu({ x: _event.clientX, y: _event.clientY, tabId, index });
          }}
        />
      </SidebarWorkspace>
      {ctxMenu && (
        <ContextMenu
          items={buildTabCloseMenuItems(
            t,
            workspaceTabs.length,
            ctxMenu.index,
            handleContextAction,
            { showRename: true },
          )}
          position={{ x: ctxMenu.x, y: ctxMenu.y }}
          onClose={() => setCtxMenu(null)}
        />
      )}
      {tableCtxMenu && (
        <ContextMenu
          items={buildTableContextMenuItems()}
          position={{ x: tableCtxMenu.x, y: tableCtxMenu.y }}
          onClose={() => setTableCtxMenu(null)}
        />
      )}
      {exportMenu && (
        <ContextMenu
          items={buildExportMenuItems()}
          position={{ x: exportMenu.x, y: exportMenu.y }}
          onClose={() => setExportMenu(null)}
        />
      )}
      <Modal
        open={pendingTabAction !== null}
        onClose={cancelPendingCommit}
      >
        {pendingTabAction && (() => {
          const dirtyCount = Object.keys(tabDirtyRows[pendingTabAction.tabId] ?? {}).length;
          return (
            <div className="warn-alert-dialog" role="alertdialog">
              <div className="warn-alert-header">
                <span className="warn-alert-icon" aria-hidden>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
                    <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                </span>
                <h3 className="warn-alert-title">{t("database.results.dirtyTitle")}</h3>
              </div>
              <div className="warn-alert-body">
                <p className="warn-alert-message">
                  {t("database.results.dirtyMessage", { count: dirtyCount })}
                </p>
              </div>
              <div className="warn-alert-footer">
                <Button type="button" variant="secondary" onClick={cancelPendingCommit}>
                  {t("database.results.dirtyRollback")}
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  onClick={confirmPendingCommit}
                  disabled={committingTabs.has(pendingTabAction.tabId)}
                >
                  {t("database.results.dirtyCommit")}
                </Button>
              </div>
            </div>
          );
        })()}
      </Modal>
      <SubWindow
        open={toolboxOpen}
        title={t("database.toolbox.open")}
        onClose={() => setToolboxOpen(false)}
      >
        <DatabaseToolbox
          connections={groupConnections}
          initialSourceConnectionId={activeConn?.id}
          initialSourceDatabase={activeSqlDatabase}
        />
      </SubWindow>
      <ConnectionDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSaved={() => setSchemaRefreshToken((token) => token + 1)}
        defaultGroup={activeGroupName}
        groups={groups}
      />
      {cellEdit && (() => {
        const colMeta = tableColumnMeta[cellEdit.tabId]?.find((c) => c.name === cellEdit.column);
        return (
          <CellEditorDialog
            open
            columnName={cellEdit.column}
            columnType={colMeta?.type ?? "text"}
            currentValue={cellEdit.row[cellEdit.column]}
            onSave={handleCellSave}
            onCancel={() => setCellEdit(null)}
          />
        );
      })()}
    </DbWorkspaceProvider>
  );
}
