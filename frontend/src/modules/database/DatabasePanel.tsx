import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DockWorkspace, DockLayout, DockPanel, DockHandle } from "../../components/dock";
import { SchemaBrowser, type BackendConnection } from "./SchemaBrowser";
import { ConnectionDialog } from "./ConnectionDialog";
import { commands, type DbConnectionConfig } from "../../ipc/bindings";
import { useActionStore } from "../../stores/actionStore";
import { useTopbarTabs } from "../../hooks/useTopbarTabs";
import { useI18n } from "../../i18n";
import { SqlEditor } from "./SqlEditor";

const DEFAULT_SQL = `SELECT 1;`;

/** db_execute_query 的返回结构（serde camelCase）。 */
interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowsAffected: number;
}

function cellToText(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function DatabasePanel() {
  const { t } = useI18n();
  const [sql, setSql] = useState(DEFAULT_SQL);
  const enqueueAction = useActionStore((s) => s.enqueueAction);
  const [dialogOpen, setDialogOpen] = useState(false);

  const [connections, setConnections] = useState<DbConnectionConfig[]>([]);
  const [activeConnId, setActiveConnId] = useState<string | null>(null);
  const [tables, setTables] = useState<string[]>([]);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);

  const activeConn = useMemo(
    () => connections.find((c) => c.id === activeConnId) ?? null,
    [connections, activeConnId],
  );

  const refreshConnections = useCallback(async () => {
    try {
      const res = await commands.dbListConnections();
      if (res.status === "ok") {
        setConnections(res.data);
        setActiveConnId((prev) => prev ?? res.data[0]?.id ?? null);
      }
    } catch {
      // 非 Tauri 环境（纯前端 dev）忽略。
    }
  }, []);

  useEffect(() => {
    void refreshConnections();
  }, [refreshConnections]);

  // 切换连接时拉取表列表。
  useEffect(() => {
    if (!activeConn) {
      setTables([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await commands.dbListTables(activeConn);
        if (!cancelled) setTables(res.status === "ok" ? res.data : []);
      } catch {
        if (!cancelled) setTables([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeConn]);

  const backendConnections: BackendConnection[] = useMemo(
    () =>
      connections.map((c) => ({
        id: c.id,
        name: c.name,
        engine: c.db_type,
        tables: c.id === activeConnId ? tables : [],
      })),
    [connections, activeConnId, tables],
  );

  const schema = useMemo(() => tables.map((name) => ({ name, columns: [] })), [tables]);

  const topbarTabs = useMemo(
    () =>
      connections.map((c) => ({
        id: c.id,
        label: c.name,
        active: c.id === activeConnId,
      })),
    [connections, activeConnId],
  );

  useTopbarTabs(
    topbarTabs,
    { onSelect: (id) => setActiveConnId(id) },
    { mode: "connection", showAddTab: true, addTabTitle: t("shell.topbar.newConnection") },
  );

  const runQuery = useCallback(async () => {
    if (!activeConn) {
      setError(t("database.results.noConnection"));
      return;
    }
    setRunning(true);
    setError(null);
    enqueueAction({
      type: "sql",
      title: t("database.actions.runQuery"),
      description: `${activeConn.name} · ${t("database.actions.runQueryDesc")}`,
      command: sql,
      resourceId: activeConn.id,
      source: "用户",
    });
    const started = performance.now();
    try {
      const res = await invoke<QueryResult>("db_execute_query", { connection: activeConn, sql });
      setResult(res);
      setElapsed(Math.round(performance.now() - started));
    } catch (e) {
      setResult(null);
      setError(typeof e === "string" ? e : JSON.stringify(e));
    } finally {
      setRunning(false);
    }
  }, [activeConn, enqueueAction, sql, t]);

  const handleSaveConnection = useCallback(
    async (data: { engine: string; name: string; host: string; port: string; database: string; username: string; password: string }) => {
      try {
        await commands.dbSaveConnection({
          id: "",
          name: data.name,
          db_type: data.engine,
          host: data.host,
          port: Number(data.port) || 0,
          user: data.username,
          password: data.password,
          database: data.database,
          group: "",
          status: "",
        });
        await refreshConnections();
      } catch {
        // 忽略保存失败（非 Tauri 环境）。
      }
    },
    [refreshConnections],
  );

  const rowCount = result?.rows.length ?? 0;

  return (
    <>
    <DockWorkspace
      leftPreset="schema"
      left={
        <SchemaBrowser
          onCreateConnection={() => setDialogOpen(true)}
          connections={backendConnections}
          activeConnId={activeConnId}
          onSelectConnection={setActiveConnId}
          onRefresh={refreshConnections}
        />
      }
      main={
        <DockLayout direction="vertical">
          <DockPanel defaultSize={55} minSize={30}>
            <div className="db-editor-area">
              <div className="sql-toolbar">
                <span className="db-select" style={{ display: "flex", alignItems: "center" }}>
                  {activeConn ? `${activeConn.name} · ${activeConn.database || activeConn.db_type}` : t("database.results.noConnection")}
                </span>
                <button
                  className="btn btn-primary btn-sm"
                  style={{ marginLeft: "auto" }}
                  onClick={runQuery}
                  disabled={running || !activeConn}
                >
                  {running ? t("database.running") : t("database.runSql")}
                </button>
              </div>
              <SqlEditor value={sql} onChange={setSql} onRun={runQuery} schema={schema} />
            </div>
          </DockPanel>
          <DockHandle direction="vertical" />
          <DockPanel defaultSize={45} minSize={20}>
            <div className="results-area">
              <div className="results-header">
                <h3>{t("database.results.preview")}</h3>
                <span className="results-meta">
                  {t("database.results.meta", {
                    rows: rowCount,
                    ms: elapsed ?? 0,
                    mode: t("common.readonly"),
                  })}
                </span>
              </div>
              {error ? (
                <div className="empty-state compact text-danger" style={{ padding: "var(--sp-4)", whiteSpace: "pre-wrap" }}>
                  {error}
                </div>
              ) : result === null ? (
                <div className="empty-state compact" style={{ padding: "var(--sp-4)" }}>
                  {t("database.results.runHint")}
                </div>
              ) : result.columns.length === 0 ? (
                <div className="empty-state compact" style={{ padding: "var(--sp-4)" }}>
                  {t("database.results.affected", { rows: result.rowsAffected })}
                </div>
              ) : (
                <div className="results-grid">
                  <table>
                    <thead>
                      <tr>
                        {result.columns.map((col) => (
                          <th key={col}>{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.map((row, ri) => (
                        <tr key={ri}>
                          {row.map((cell, ci) => (
                            <td key={ci}>{cellToText(cell)}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="exec-stats">
                <span className="stat">
                  {t("database.results.title")}: <span className="stat-val">{rowCount}</span>
                </span>
                <span className="stat">
                  Latency: <span className="stat-val">{elapsed ?? 0}ms</span>
                </span>
              </div>
            </div>
          </DockPanel>
        </DockLayout>
      }
    />
    <ConnectionDialog
      open={dialogOpen}
      onClose={() => setDialogOpen(false)}
      onSave={handleSaveConnection}
    />
    </>
  );
}
