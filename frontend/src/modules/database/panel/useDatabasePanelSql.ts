import {
  useCallback,
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { useActionStore } from "../../../stores/actionStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { getShortcutKeys, matchesShortcut } from "../../../stores/shortcutsStore";
import { quickInput } from "../../../lib/quickInput";
import { isSqlEditorFocused, sqlAtOffset } from "../sqlIntel/sqlStatement";
import { splitSqlStatements } from "../sqlIntel/sqlLex";
import { makeQueryRunId, isQueryCancelledError } from "../sql/queryRun";
import { resolveSqlPresenceToken } from "../sql/sqlPresence";
import { useDbSqlFileStore } from "../../../stores/dbSqlFileStore";
import { useDbScratchQueryStore } from "../../../stores/dbScratchQueryStore";
import type { DbConnectionConfig } from "../api";
import { formatSql } from "../sqlIntel/sqlFormat";
import {
  appendSqlExecution,
  makeSqlExecId,
  markSqlExecBatchUnread,
  rebindSqlExecutionFile,
  sqlExecDisplayName,
} from "../sql/sqlExecLog";
import { patchDockTabFileMeta } from "../../../components/dock/dockTabLiveMeta";
import {
  createDefaultSqlTabState,
  planSqlExecutionSessions,
  type QueryResult,
  type SqlResultSession,
  type SqlTabState,
} from "../workspace/dbWorkspaceState";
import {
  isScratchSqlTab,
  makeSqlTabLabel,
  type DbWorkspaceTab,
  type SqlWorkspaceTab,
} from "../workspace/workspaceTabs";
import { useDbWorkspaceTabStore } from "../../../stores/dbWorkspaceTabStore";

type Translate = (key: string, params?: Record<string, string | number>) => string;
type EnqueueAction = ReturnType<typeof useActionStore.getState>["enqueueAction"];
type SetSqlTabStates = ReturnType<typeof useDbWorkspaceTabStore.getState>["setSqlTabStates"];

export type UseDatabasePanelSqlDeps = {
  workspaceTabsRef: MutableRefObject<DbWorkspaceTab[]>;
  activeWorkspaceTabIdRef: MutableRefObject<string>;
  setSqlTabStates: SetSqlTabStates;
  setDirtySqlWorkspaceTabIds: Dispatch<SetStateAction<Set<string>>>;
  dirtySqlWorkspaceTabIds: Set<string>;
  syncConnForTabId: (tabId: string) => void;
  activeWorkspaceTab: DbWorkspaceTab | null;
  activeWorkspaceTabId: string;
  connectionForSqlTab: (tabId: string, sql?: string) => DbConnectionConfig | null;
  resolveSqlTabConnection: (tabId: string) => DbConnectionConfig | null;
  enqueueAction: EnqueueAction;
  t: Translate;
  resolveConnection: (connId: string) => DbConnectionConfig | null;
  setWorkspaceTabs: Dispatch<SetStateAction<DbWorkspaceTab[]>>;
  isActiveRoute: boolean;
  sqlAutoRunNonce: number;
  pendingSqlAutoRunRef: MutableRefObject<{ tabId: string; sql: string } | null>;
};

export function useDatabasePanelSql(deps: UseDatabasePanelSqlDeps) {
  const {
    workspaceTabsRef,
    activeWorkspaceTabIdRef,
    setSqlTabStates,
    setDirtySqlWorkspaceTabIds,
    dirtySqlWorkspaceTabIds,
    syncConnForTabId,
    activeWorkspaceTab,
    activeWorkspaceTabId,
    connectionForSqlTab,
    resolveSqlTabConnection,
    enqueueAction,
    t,
    resolveConnection,
    setWorkspaceTabs,
    isActiveRoute,
    sqlAutoRunNonce,
    pendingSqlAutoRunRef,
  } = deps;

  const persistSqlFileState = useCallback((tabId: string, state: SqlTabState) => {
    const tab = workspaceTabsRef.current.find(
      (item): item is SqlWorkspaceTab => item.id === tabId && item.kind === "sql",
    );
    if (!tab?.sqlFileId) {
      return;
    }
    const store = useDbSqlFileStore.getState();
    store.updateFileSql(tab.sqlFileId, state.sql);
    store.updateFileBinding(tab.sqlFileId, state.connId, state.database);
  }, []);

  const persistScratchQueryState = useCallback((tabId: string, state: SqlTabState) => {
    const tab = workspaceTabsRef.current.find(
      (item): item is SqlWorkspaceTab => item.id === tabId && item.kind === "sql",
    );
    if (!tab || !isScratchSqlTab(tab)) {
      return;
    }
    useDbScratchQueryStore.getState().setDraft({
      sql: state.sql,
      connId: state.connId,
      database: state.database,
      cursorOffset: state.cursorOffset,
    });
  }, []);

  const syncSqlFileTabHeaderMeta = useCallback(
    (tabId: string, dirty: boolean, savedOverride?: boolean) => {
      const tab = workspaceTabsRef.current.find(
        (item): item is SqlWorkspaceTab => item.id === tabId && item.kind === "sql",
      );
      if (!tab || useDbWorkspaceTabStore.getState().tablePreviews[tab.id]?.tableName) {
        return;
      }
      if (isScratchSqlTab(tab)) {
        patchDockTabFileMeta(tabId, {
          type: "file",
          dirty: false,
          saved: false,
        });
        return;
      }
      patchDockTabFileMeta(tabId, {
        type: "file",
        dirty,
        saved: savedOverride ?? (Boolean(tab.sqlFileId) && !dirty),
      });
    },
    [],
  );

  const updateSqlTabState = useCallback((tabId: string, patch: Partial<SqlTabState>) => {
    const shouldPersistFile =
      patch.sql !== undefined || patch.connId !== undefined || patch.database !== undefined;
    const shouldPersistScratch =
      shouldPersistFile || patch.cursorOffset !== undefined;
    let nextStateForPersist: SqlTabState | null = null;

    setSqlTabStates((prev) => {
      const nextState = { ...(prev[tabId] ?? createDefaultSqlTabState()), ...patch };
      if (shouldPersistFile || shouldPersistScratch) {
        nextStateForPersist = nextState;
      }
      return { ...prev, [tabId]: nextState };
    });

    if (nextStateForPersist) {
      if (shouldPersistFile) {
        persistSqlFileState(tabId, nextStateForPersist);
      }
      if (shouldPersistScratch) {
        persistScratchQueryState(tabId, nextStateForPersist);
      }
    }

    if (patch.sql !== undefined || patch.connId !== undefined || patch.database !== undefined) {
      const tab = workspaceTabsRef.current.find((item) => item.id === tabId);
      if (tab?.kind === "sql" && !isScratchSqlTab(tab)) {
        setDirtySqlWorkspaceTabIds((prev) => {
          if (prev.has(tabId)) return prev;
          const next = new Set(prev);
          next.add(tabId);
          return next;
        });
        syncSqlFileTabHeaderMeta(tabId, true);
      }
    }

    if (
      (patch.connId !== undefined || patch.database !== undefined) &&
      activeWorkspaceTabIdRef.current === tabId
    ) {
      syncConnForTabId(tabId);
    }
  }, [persistSqlFileState, persistScratchQueryState, syncSqlFileTabHeaderMeta, syncConnForTabId]);

  const updateSqlResultSession = useCallback(
    (sqlTabId: string, sessionId: string, patch: Partial<SqlResultSession>) => {
      setSqlTabStates((prev) => {
        const tab = prev[sqlTabId] ?? createDefaultSqlTabState();
        const sessions = tab.resultSessions ?? [];
        return {
          ...prev,
          [sqlTabId]: {
            ...tab,
            resultSessions: sessions.map((session) =>
              session.id === sessionId ? { ...session, ...patch } : session,
            ),
          },
        };
      });
    },
    [setSqlTabStates],
  );

  const closeSqlResultSession = useCallback(
    (sqlTabId: string, sessionId: string) => {
      setSqlTabStates((prev) => {
        const tab = prev[sqlTabId] ?? createDefaultSqlTabState();
        const sessions = (tab.resultSessions ?? []).filter((item) => item.id !== sessionId);
        const activeResultSessionId =
          tab.activeResultSessionId === sessionId
            ? sessions[sessions.length - 1]?.id ?? null
            : tab.activeResultSessionId;
        return {
          ...prev,
          [sqlTabId]: {
            ...tab,
            resultSessions: sessions,
            activeResultSessionId,
          },
        };
      });
    },
    [setSqlTabStates],
  );

  const setSqlResultSessionPinned = useCallback(
    (sqlTabId: string, sessionId: string, pinned: boolean) => {
      setSqlTabStates((prev) => {
        const tab = prev[sqlTabId] ?? createDefaultSqlTabState();
        let sessions = tab.resultSessions ?? [];
        const target = sessions.find((item) => item.id === sessionId);
        if (!target || Boolean(target.pinned) === pinned) {
          return prev;
        }

        if (!pinned) {
          const otherTemp = sessions.find((item) => !item.pinned && item.id !== sessionId);
          if (otherTemp) {
            sessions = sessions.map((item) =>
              item.id === otherTemp.id ? { ...item, pinned: true } : item,
            );
          }
        }

        sessions = sessions.map((item) =>
          item.id === sessionId ? { ...item, pinned } : item,
        );

        return {
          ...prev,
          [sqlTabId]: {
            ...tab,
            resultSessions: sessions,
          },
        };
      });
    },
    [setSqlTabStates],
  );

  const setSqlTabConnection = useCallback(
    (tabId: string, connId: string | null) => {
      const nextConnId = connId ?? "";
      const prevConnId =
        useDbWorkspaceTabStore.getState().sqlTabStates[tabId]?.connId ?? "";
      if (nextConnId === prevConnId) {
        return;
      }
      updateSqlTabState(tabId, { connId: nextConnId, database: "" });
    },
    [updateSqlTabState],
  );

  const runQuery = useCallback(async (
    sqlOverride?: string,
    tabIdOverride?: string,
    options?: { resultPage?: number; sessionId?: string; freshResult?: boolean },
  ) => {
    const tabStore = useDbWorkspaceTabStore.getState();
    const pageSize = useSettingsStore.getState().databaseQueryPageSize;

    const tabId = tabIdOverride ?? activeWorkspaceTab?.id;
    const tab = tabId ? workspaceTabsRef.current.find((item) => item.id === tabId) : null;
    if (!tab || tab.kind !== "sql") {
      return;
    }
    const resolvedTabId = tab.id;
    const tabState = tabStore.sqlTabStates[resolvedTabId] ?? createDefaultSqlTabState();
    const sessions = tabState.resultSessions ?? [];

    if (options?.sessionId) {
      const session = sessions.find((item) => item.id === options.sessionId);
      if (!session) return;
      const sql = session.sql.trim();
      if (!sql) return;
      const conn = connectionForSqlTab(resolvedTabId, sql);
      if (!conn) {
        updateSqlResultSession(resolvedTabId, session.id, {
          error: resolveSqlTabConnection(resolvedTabId)
            ? t("database.workspace.selectDatabase")
            : t("database.results.noConnection"),
        });
        return;
      }

      const resultPage = Math.max(0, options.resultPage ?? 0);
      updateSqlResultSession(resolvedTabId, session.id, { running: true, error: null });
      const started = performance.now();
      const runId = makeQueryRunId();
      const presenceToken = await resolveSqlPresenceToken(conn, sql, t);
      if (presenceToken === null) {
        updateSqlResultSession(resolvedTabId, session.id, { running: false });
        return;
      }
      try {
        const res = await invoke<QueryResult>("db_execute_query", {
          connection: conn,
          sql,
          runId,
          limit: pageSize,
          offset: resultPage * pageSize,
          presenceToken: presenceToken ?? null,
        });
        const hasMore = res.columns.length > 0 && res.rows.length >= pageSize;
        updateSqlResultSession(resolvedTabId, session.id, {
          result: res,
          resultPage,
          resultHasMore: hasMore,
          elapsed: Math.round(performance.now() - started),
          running: false,
        });
      } catch (e) {
        updateSqlResultSession(resolvedTabId, session.id, {
          result: null,
          error: isQueryCancelledError(e)
            ? t("database.queryCancelled")
            : typeof e === "string"
              ? e
              : JSON.stringify(e),
          running: false,
        });
      }
      return;
    }

    const sql = (sqlOverride ?? tabState.sql).trim();

    if (!sql) {
      updateSqlTabState(resolvedTabId, { error: t("database.results.emptySql") });
      return;
    }

    const conn = connectionForSqlTab(resolvedTabId, sql);
    if (!conn) {
      updateSqlTabState(resolvedTabId, {
        error: resolveSqlTabConnection(resolvedTabId)
          ? t("database.workspace.selectDatabase")
          : t("database.results.noConnection"),
      });
      return;
    }

    const freshResult = options?.freshResult === true;
    const statementSqls = splitSqlStatements(sql).map((part) => part.sql);
    const statements = statementSqls.length > 0 ? statementSqls : [sql];
    if (tabState.activeQueryRunId) {
      try {
        await invoke("db_cancel_query", { runId: tabState.activeQueryRunId });
      } catch {
        // 查询可能已结束
      }
    }

    const planned = planSqlExecutionSessions(sessions, statements, freshResult);
    const plannedSessions = planned.runSessionIds
      .map((id) => planned.sessions.find((item) => item.id === id))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    updateSqlTabState(resolvedTabId, {
      running: true,
      activeQueryRunId: null,
      error: null,
      resultSessions: planned.sessions,
      activeResultSessionId: planned.activeSessionId,
    });

    enqueueAction({
      type: "sql",
      title: t("database.actions.runQuery"),
      description: `${conn.name} · ${t("database.actions.runQueryDesc")}`,
      command: sql,
      resourceId: conn.id,
      source: "用户",
    });

    const useManualTxn = tabState.autoCommit === false;
    // 多条语句共用一条连接，用户变量和临时表在脚本内仍然可见；
    // 每条成功后提交，保持自动提交语义。手动事务继续用标签自己的会话。
    const scriptSessionId =
      !useManualTxn && plannedSessions.length > 1
        ? `${resolvedTabId}::script::${makeQueryRunId()}`
        : null;
    const historyTab = workspaceTabsRef.current.find((item) => item.id === resolvedTabId);
    const sqlFileId = historyTab?.kind === "sql" ? historyTab.sqlFileId ?? null : null;
    let anySuccess = false;
    let lastRunId: string | null = null;
    const batchIds: string[] = [];
    const trackBatch = plannedSessions.length > 1;

    const currentRunId = () =>
      useDbWorkspaceTabStore.getState().sqlTabStates[resolvedTabId]?.activeQueryRunId ?? null;

    const dropSessions = (sessionIds: string[], activeSessionId: string | null) => {
      const current = useDbWorkspaceTabStore.getState().sqlTabStates[resolvedTabId];
      const drop = new Set(sessionIds);
      const kept = (current?.resultSessions ?? []).filter((item) => !drop.has(item.id));
      updateSqlTabState(resolvedTabId, {
        resultSessions: kept,
        activeResultSessionId:
          activeSessionId && kept.some((item) => item.id === activeSessionId)
            ? activeSessionId
            : kept[kept.length - 1]?.id ?? null,
      });
    };

    for (let index = 0; index < plannedSessions.length; index += 1) {
      const session = plannedSessions[index]!;
      const runId = makeQueryRunId();
      lastRunId = runId;
      updateSqlTabState(resolvedTabId, {
        running: true,
        activeQueryRunId: runId,
        activeResultSessionId: session.id,
      });
      updateSqlResultSession(resolvedTabId, session.id, { running: true, error: null });

      const presenceToken = await resolveSqlPresenceToken(conn, session.sql, t);
      if (currentRunId() !== runId) break;
      if (presenceToken === null) {
        dropSessions(
          plannedSessions.slice(index).map((item) => item.id),
          plannedSessions[index - 1]?.id ?? null,
        );
        break;
      }

      const started = performance.now();
      const logExec = (
        status: "ok" | "error" | "cancelled",
        extra: {
          elapsedMs: number;
          rowsAffected?: number;
          error?: string;
          columns?: string[];
          rows?: unknown[][];
        },
      ) => {
        const executionId = makeSqlExecId();
        if (trackBatch) batchIds.push(executionId);
        updateSqlResultSession(resolvedTabId, session.id, { executionId });
        void appendSqlExecution({
          id: executionId,
          executedAt: Date.now(),
          connectionId: conn.id,
          connectionName: conn.name,
          databaseName: conn.database,
          envTag: "",
          sqlFileId,
          tabId: resolvedTabId,
          sql: session.sql,
          displayName: sqlExecDisplayName(session.sql, "SQL"),
          status,
          elapsedMs: extra.elapsedMs,
          rowsAffected: extra.rowsAffected ?? 0,
          error: extra.error ?? "",
          pinned: Boolean(session.pinned),
          columns: extra.columns ?? [],
          rows: extra.rows ?? [],
        });
      };
      try {
        const res =
          useManualTxn || scriptSessionId
            ? await invoke<QueryResult>("db_execute_query_in_session", {
                sessionId: scriptSessionId ?? resolvedTabId,
                connection: conn,
                sql: session.sql,
                runId,
                limit: pageSize,
                offset: 0,
                presenceToken: presenceToken ?? null,
              })
            : await invoke<QueryResult>("db_execute_query", {
                connection: conn,
                sql: session.sql,
                runId,
                limit: pageSize,
                offset: 0,
                presenceToken: presenceToken ?? null,
              });
        if (currentRunId() !== runId) {
          logExec("cancelled", { elapsedMs: Math.round(performance.now() - started) });
          break;
        }
        if (scriptSessionId) {
          await invoke("db_query_session_commit", { sessionId: scriptSessionId });
          if (currentRunId() !== runId) break;
        }
        const elapsed = Math.round(performance.now() - started);
        const hasMore = res.columns.length > 0 && res.rows.length >= pageSize;
        updateSqlResultSession(resolvedTabId, session.id, {
          result: res,
          resultPage: 0,
          resultHasMore: hasMore,
          elapsed,
          running: false,
        });
        anySuccess = true;
        logExec("ok", {
          elapsedMs: elapsed,
          rowsAffected: res.rowsAffected,
          columns: res.columns,
          rows: res.rows,
        });
      } catch (e) {
        const cancelled = currentRunId() !== runId || isQueryCancelledError(e);
        if (currentRunId() !== runId && !isQueryCancelledError(e)) {
          logExec("cancelled", { elapsedMs: Math.round(performance.now() - started) });
          break;
        }
        const message = cancelled
          ? t("database.queryCancelled")
          : typeof e === "string"
            ? e
            : JSON.stringify(e);
        updateSqlResultSession(resolvedTabId, session.id, {
          result: null,
          error: message,
          running: false,
        });
        logExec(cancelled ? "cancelled" : "error", {
          elapsedMs: Math.round(performance.now() - started),
          error: cancelled ? "" : message,
        });
        dropSessions(
          plannedSessions.slice(index + 1).map((item) => item.id),
          session.id,
        );
        break;
      }
    }

    if (scriptSessionId) {
      try {
        await invoke("db_query_session_close", { sessionId: scriptSessionId });
      } catch {
        // 会话可能尚未建立
      }
    }

    if (trackBatch && batchIds.length > 1) {
      const current = useDbWorkspaceTabStore.getState().sqlTabStates[resolvedTabId];
      const focused = current?.resultSessions?.find(
        (item) => item.id === current.activeResultSessionId,
      )?.executionId;
      markSqlExecBatchUnread(batchIds.filter((id) => id !== focused));
    }

    if (currentRunId() === lastRunId) {
      updateSqlTabState(resolvedTabId, {
        running: false,
        activeQueryRunId: null,
        ...(useManualTxn && anySuccess ? { inTransaction: true } : {}),
      });
    }
  }, [
    connectionForSqlTab,
    resolveSqlTabConnection,
    activeWorkspaceTab,
    enqueueAction,
    t,
    updateSqlTabState,
    updateSqlResultSession,
  ]);

  // 快捷启动 / follow openSqlDraft(autoRun)：草稿挂载后再执行
  useEffect(() => {
    if (!sqlAutoRunNonce) return;
    const pending = pendingSqlAutoRunRef.current;
    if (!pending) return;
    pendingSqlAutoRunRef.current = null;
    const timer = window.setTimeout(() => {
      void runQuery(pending.sql, pending.tabId);
    }, 80);
    return () => window.clearTimeout(timer);
  }, [sqlAutoRunNonce, runQuery]);

  const cancelQuery = useCallback(async (tabIdOverride?: string) => {
    const tabId = tabIdOverride ?? activeWorkspaceTab?.id;
    if (!tabId) return;

    const tabState = useDbWorkspaceTabStore.getState().sqlTabStates[tabId];
    const runId = tabState?.activeQueryRunId;
    if (!runId) return;

    try {
      await invoke("db_cancel_query", { runId });
    } catch {
      // 查询可能已结束
    }

    const runningSessions = (tabState.resultSessions ?? []).filter((item) => item.running);
    const cancelTargets =
      runningSessions.length > 0
        ? runningSessions
        : tabState.activeResultSessionId
          ? (tabState.resultSessions ?? []).filter((item) => item.id === tabState.activeResultSessionId)
          : [];
    for (const session of cancelTargets) {
      updateSqlResultSession(tabId, session.id, {
        running: false,
        error: t("database.queryCancelled"),
      });
    }
    updateSqlTabState(tabId, { running: false, activeQueryRunId: null });
  }, [activeWorkspaceTab, t, updateSqlResultSession, updateSqlTabState]);

  const setSqlAutoCommit = useCallback(
    async (tabId: string, autoCommit: boolean) => {
      const tabState = useDbWorkspaceTabStore.getState().sqlTabStates[tabId];
      if (!tabState) return;
      if (autoCommit === tabState.autoCommit) return;

      if (autoCommit) {
        // 切回自动提交：若有未提交事务则提交并关闭会话
        if (tabState.inTransaction) {
          try {
            await invoke("db_query_session_commit", { sessionId: tabId });
          } catch (e) {
            const message = typeof e === "string" ? e : JSON.stringify(e);
            updateSqlTabState(tabId, { error: message });
            return;
          }
        }
        try {
          await invoke("db_query_session_close", { sessionId: tabId });
        } catch {
          // ignore
        }
        updateSqlTabState(tabId, { autoCommit: true, inTransaction: false, error: null });
        return;
      }

      updateSqlTabState(tabId, { autoCommit: false, error: null });
    },
    [updateSqlTabState],
  );

  const commitSqlTransaction = useCallback(
    async (tabId: string) => {
      try {
        await invoke("db_query_session_commit", { sessionId: tabId });
        updateSqlTabState(tabId, { inTransaction: false, error: null });
      } catch (e) {
        updateSqlTabState(tabId, {
          error: typeof e === "string" ? e : JSON.stringify(e),
        });
      }
    },
    [updateSqlTabState],
  );

  const rollbackSqlTransaction = useCallback(
    async (tabId: string) => {
      try {
        await invoke("db_query_session_rollback", { sessionId: tabId });
        updateSqlTabState(tabId, { inTransaction: false, error: null });
      } catch (e) {
        updateSqlTabState(tabId, {
          error: typeof e === "string" ? e : JSON.stringify(e),
        });
      }
    },
    [updateSqlTabState],
  );

  const goToQueryResultPage = useCallback(
    async (tabId: string, page: number, sessionId?: string) => {
      if (page < 0) return;
      const tabState = useDbWorkspaceTabStore.getState().sqlTabStates[tabId];
      const resolvedSessionId =
        sessionId ?? tabState?.activeResultSessionId ?? undefined;
      if (!resolvedSessionId) return;
      await runQuery(undefined, tabId, { sessionId: resolvedSessionId, resultPage: page });
    },
    [runQuery],
  );

  // 表预览（data）模式：编辑器常折叠且无焦点，在此统一处理 run-current-sql 快捷键
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (!matchesShortcut(e, getShortcutKeys("run-current-sql"))) return;
      if (isSqlEditorFocused()) return;

      const tabId = activeWorkspaceTabId;
      if (!tabId) return;
      const tabState = useDbWorkspaceTabStore.getState().sqlTabStates[tabId];
      if (!tabState) return;

      const statement = sqlAtOffset(tabState.sql, tabState.cursorOffset);
      if (!statement) return;

      e.preventDefault();
      e.stopPropagation();
      void runQuery(statement, tabId);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [activeWorkspaceTabId, runQuery]);

  const isSqlTabDirty = useCallback(
    (tabId: string) => dirtySqlWorkspaceTabIds.has(tabId),
    [dirtySqlWorkspaceTabIds],
  );

  const saveSqlTab = useCallback(
    async (tabIdOverride?: string) => {
      const tabId = tabIdOverride ?? activeWorkspaceTabId;
      if (!tabId) return;

      const tab = workspaceTabsRef.current.find(
        (item): item is SqlWorkspaceTab => item.id === tabId && item.kind === "sql",
      );
      if (!tab) return;

      const state = useDbWorkspaceTabStore.getState().sqlTabStates[tabId] ?? createDefaultSqlTabState();
      const store = useDbSqlFileStore.getState();
      const connection = resolveConnection(state.connId);
      const rawSql = state.sql;
      const sqlToSave =
        useSettingsStore.getState().formatSqlOnSave
          ? formatSql(rawSql, connection?.db_type ?? null)
          : rawSql;
      if (sqlToSave !== state.sql) {
        updateSqlTabState(tabId, { sql: sqlToSave });
      }

      if (tab.sqlFileId) {
        store.updateFileSql(tab.sqlFileId, sqlToSave);
        store.updateFileBinding(tab.sqlFileId, state.connId, state.database);
        await store.flushToDisk();
        setDirtySqlWorkspaceTabIds((prev) => {
          if (!prev.has(tabId)) return prev;
          const next = new Set(prev);
          next.delete(tabId);
          return next;
        });
        syncSqlFileTabHeaderMeta(tabId, false);
        return;
      }

      if (isScratchSqlTab(tab)) {
        useDbScratchQueryStore.getState().setDraft({
          sql: sqlToSave,
          connId: state.connId,
          database: state.database,
          cursorOffset: state.cursorOffset,
        });
        setDirtySqlWorkspaceTabIds((prev) => {
          if (!prev.has(tabId)) return prev;
          const next = new Set(prev);
          next.delete(tabId);
          return next;
        });
        syncSqlFileTabHeaderMeta(tabId, false, false);
        return;
      }

      const name = await quickInput({
        title: t("database.queryFiles.saveAsTitle"),
        placeholder: t("database.queryFiles.fileNamePlaceholder"),
        defaultValue: t("database.queryFiles.defaultFileName"),
        validate: (value) =>
          value.trim() ? null : t("database.queryFiles.nameRequired"),
      });
      if (!name) return;

      const file = store.addFile(null, name.trim(), sqlToSave);
      store.updateFileBinding(file.id, state.connId, state.database);
      setWorkspaceTabs((prev) =>
        prev.map((item) =>
          item.id === tabId
            ? {
                ...item,
                label: makeSqlTabLabel({
                  action:
                    file.name.replace(/\.sql$/i, "") || t("database.workspace.tabAction.sql"),
                  database: state.database,
                  connection: connection?.name ?? null,
                }),
                sqlFileId: file.id,
              }
            : item,
        ),
      );
      setDirtySqlWorkspaceTabIds((prev) => {
        if (!prev.has(tabId)) return prev;
        const next = new Set(prev);
        next.delete(tabId);
        return next;
      });
      syncSqlFileTabHeaderMeta(tabId, false, true);
      await rebindSqlExecutionFile(tabId, file.id);
      await store.flushToDisk();
    },
    [activeWorkspaceTabId, t, syncSqlFileTabHeaderMeta, resolveConnection, updateSqlTabState],
  );

  const renameActiveSqlQuery = useCallback(async () => {
    const tabId = activeWorkspaceTabIdRef.current;
    const tab = workspaceTabsRef.current.find((item) => item.id === tabId);
    if (!tab || tab.kind !== "sql") return;
    if (tab.sqlFileId) {
      const file = useDbSqlFileStore.getState().getNode(tab.sqlFileId);
      if (!file || file.type !== "file") return;
      const name = await quickInput({
        title: t("database.queryFiles.renameTitle"),
        defaultValue: file.name.replace(/\.sql$/i, ""),
        validate: (value) => (value.trim() ? null : t("database.queryFiles.nameRequired")),
      });
      if (!name) return;
      useDbSqlFileStore.getState().renameNode(file.id, name.trim());
      return;
    }
    const name = await quickInput({
      title: t("database.queryFiles.renameTitle"),
      defaultValue: tab.label,
      validate: (value) => (value.trim() ? null : t("database.queryFiles.nameRequired")),
    });
    if (!name) return;
    setWorkspaceTabs((prev) =>
      prev.map((item) => (item.id === tabId ? { ...item, label: name.trim() } : item)),
    );
  }, [setWorkspaceTabs, t]);

  useEffect(() => {
    if (!isActiveRoute) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.repeat) return;
      if (!matchesShortcut(e, getShortcutKeys("rename-tab"))) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest("input, textarea, select")) return;
      if (target?.closest(".sql-query-file-tree")) return;
      const tab = workspaceTabsRef.current.find(
        (item) => item.id === activeWorkspaceTabIdRef.current,
      );
      if (!tab || tab.kind !== "sql") return;
      e.preventDefault();
      e.stopPropagation();
      void renameActiveSqlQuery();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [isActiveRoute, renameActiveSqlQuery]);

  useEffect(() => {
    if (!isActiveRoute) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s" || e.shiftKey || e.altKey) {
        return;
      }
      if (isSqlEditorFocused()) return;
      if (!activeWorkspaceTabId) return;
      const tab = workspaceTabsRef.current.find((item) => item.id === activeWorkspaceTabId);
      if (!tab || tab.kind !== "sql") return;
      e.preventDefault();
      e.stopPropagation();
      void saveSqlTab(activeWorkspaceTabId);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [isActiveRoute, activeWorkspaceTabId, saveSqlTab]);

  return {
    persistSqlFileState,
    persistScratchQueryState,
    syncSqlFileTabHeaderMeta,
    updateSqlTabState,
    updateSqlResultSession,
    closeSqlResultSession,
    setSqlResultSessionPinned,
    setSqlTabConnection,
    runQuery,
    cancelQuery,
    setSqlAutoCommit,
    commitSqlTransaction,
    rollbackSqlTransaction,
    goToQueryResultPage,
    isSqlTabDirty,
    saveSqlTab,
  };
}
