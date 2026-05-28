import { useMemo, useState } from "react";
import { DockWorkspace } from "../../components/dock";
import { SchemaBrowser } from "./SchemaBrowser";
import { workspaceResources, getResourceById } from "../../lib/resourceRegistry";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useActionStore } from "../../stores/actionStore";
import { useTopbarTabs } from "../../hooks/useTopbarTabs";
import { useI18n } from "../../i18n";
import { SqlEditor } from "./SqlEditor";

const DEFAULT_SQL = `SELECT id, email, status, created_at
FROM users
WHERE status = 'active'
ORDER BY created_at DESC
LIMIT 50;`;

const resultRows = [
  ["1001", "alice@example.com", "active", "2026-05-28 09:41"],
  ["1002", "bob@example.com", "active", "2026-05-28 09:38"],
  ["1003", "carol@example.com", "active", "2026-05-28 09:12"],
];

export function DatabasePanel() {
  const { t } = useI18n();
  const [sql, setSql] = useState(DEFAULT_SQL);
  const activeResourceId = useWorkspaceStore((s) => s.activeResourceId);
  const selectResource = useWorkspaceStore((s) => s.selectResource);
  const activeResource = getResourceById(activeResourceId);
  const enqueueAction = useActionStore((s) => s.enqueueAction);
  const actions = useActionStore((s) => s.actions);

  const dbResources = useMemo(
    () => workspaceResources.filter((resource) => resource.type === "database"),
    []
  );

  const topbarTabs = useMemo(
    () =>
      dbResources.map((resource) => ({
        id: resource.id,
        label: resource.name,
        active: resource.id === (activeResourceId ?? dbResources[0]?.id),
      })),
    [dbResources, activeResourceId]
  );

  useTopbarTabs(topbarTabs, {
    onSelect: (id) => selectResource(id),
  }, { mode: "connection", showAddTab: true, addTabTitle: t("shell.topbar.newConnection") });

  const sqlActions = useMemo(
    () => actions.filter((action) => action.type === "sql").slice(0, 4),
    [actions]
  );

  const runQuery = () => {
    enqueueAction({
      type: "sql",
      title: t("database.actions.runQuery"),
      description: t("database.actions.runQueryDesc"),
      command: sql,
      resourceId: activeResource?.id ?? "prod-db-master",
      source: "用户",
    });
  };

  return (
    <DockWorkspace
      leftPreset="schema"
      left={<SchemaBrowser />}
      main={
        <div className="db-editor-area">
          <div className="sql-editor-wrap">
            <div className="sql-toolbar">
              <select className="db-select" defaultValue="app_production">
                <option value="app_production">app_production</option>
                <option value="analytics">analytics</option>
              </select>
              <button className="btn btn-primary btn-sm" style={{ marginLeft: "auto" }} onClick={runQuery}>
                {t("database.runSql")}
              </button>
            </div>
            <SqlEditor value={sql} onChange={setSql} />
          </div>
          <div className="results-area">
            <div className="results-header">
              <h3>{t("database.results.preview")}</h3>
              <span className="results-meta">
                {t("database.results.meta", {
                  rows: resultRows.length,
                  ms: 18,
                  mode: t("common.readonly"),
                })}
              </span>
            </div>
            <div className="results-grid">
              <table>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Email</th>
                    <th>Status</th>
                    <th>Created At</th>
                  </tr>
                </thead>
                <tbody>
                  {resultRows.map((row) => (
                    <tr key={row[0]}>{row.map((cell) => <td key={cell}>{cell}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="exec-stats">
              <span className="stat">
                {t("database.results.title")}: <span className="stat-val">{resultRows.length}</span>
              </span>
              <span className="stat">
                Latency: <span className="stat-val">18ms</span>
              </span>
            </div>
          </div>
        </div>
      }
      right={
        <div className="context-panel db-ai-panel">
          <div className="panel-title">{t("database.context.title")}</div>
          <div className="context-card">
            <span className="context-label">{t("database.context.connection")}</span>
            <strong>{activeResource?.name ?? "prod-db-master"}</strong>
            <span>{activeResource?.subtitle ?? "PostgreSQL 16"}</span>
          </div>
          <div className="context-card">
            <span className="context-label">{t("database.context.aiContext")}</span>
            <span>{t("database.context.aiContextDesc")}</span>
          </div>
          <button
            className="btn btn-danger btn-sm"
            onClick={() =>
              enqueueAction({
                type: "sql",
                title: t("database.actions.dangerDraft"),
                description: t("database.actions.dangerDraftDesc"),
                command: "DELETE FROM users",
                resourceId: activeResource?.id ?? "prod-db-master",
                source: "AI",
              })
            }
          >
            {t("database.context.dangerSql")}
          </button>
        </div>
      }
      bottom={
        <div className="bottom-feed">
          <div className="panel-title">{t("database.feed.title")}</div>
          {sqlActions.map((action) => (
            <div key={action.id} className="feed-row">
              <span>{action.title}</span>
              <span>{action.status}</span>
            </div>
          ))}
        </div>
      }
    />
  );
}
