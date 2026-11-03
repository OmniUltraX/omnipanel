import { useEffect, useState } from "react";
import { Select } from "../../../../components/ui/form/Select";
import { WorkbenchActionButton } from "../../../../components/ui/primitives/WorkbenchActionButton";
import { t } from "../../../../i18n";
import {
  isConnectionEnabled,
  isSqlCapableConnection,
  listDatabases,
  type DbConnectionConfig,
} from "../../api";
import type { SqlExecTarget } from "../../sqlIntel/sqlStatementTargets";

const databaseCache = new Map<string, string[]>();

export async function loadSqlTargetDatabases(
  connId: string,
  connections: readonly DbConnectionConfig[],
  getDatabases: (connId: string) => string[],
): Promise<string[]> {
  if (!connId) return [];
  let names = getDatabases(connId);
  if (names.length === 0) names = databaseCache.get(connId) ?? [];
  if (names.length > 0) return names;
  const conn = connections.find((item) => item.id === connId);
  if (!conn) return [];
  try {
    names = await listDatabases({ ...conn, database: conn.database || "" }, { quiet: true });
    databaseCache.set(connId, names);
    return names;
  } catch {
    return [];
  }
}

export function sqlTargetConnections(connections: readonly DbConnectionConfig[]): DbConnectionConfig[] {
  return connections
    .filter((conn) => isSqlCapableConnection(conn) && isConnectionEnabled(conn))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

interface SqlExecTargetPickerProps {
  connections: readonly DbConnectionConfig[];
  getDatabases: (connId: string) => string[];
  mode: "add" | "edit";
  initial: SqlExecTarget | null;
  canRemove: boolean;
  onCommit: (target: SqlExecTarget) => void;
  onRemove: () => void;
}

/** 跟工具栏同一套 Select。下拉层挂在 body 上，不能用原生 select，否则弹层的按下会被吃掉。 */
export function SqlExecTargetPicker({
  connections,
  getDatabases,
  mode,
  initial,
  canRemove,
  onCommit,
  onRemove,
}: SqlExecTargetPickerProps) {
  const [connId, setConnId] = useState(initial?.connId ?? "");
  const [database, setDatabase] = useState(mode === "add" ? "" : (initial?.database ?? ""));
  const [databases, setDatabases] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const ready = Boolean(connId && database);
  const unchanged =
    mode === "edit" &&
    connId === (initial?.connId ?? "") &&
    database.toLowerCase() === (initial?.database ?? "").toLowerCase();

  useEffect(() => {
    let cancelled = false;
    if (!connId) {
      setDatabases([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    void loadSqlTargetDatabases(connId, connections, getDatabases).then((names) => {
      if (cancelled) return;
      setDatabases(names);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [connId, connections, getDatabases]);

  return (
    <div
      className="cm-sql-exec-target-picker__body"
      onMouseDown={(event) => {
        const target = event.target;
        if (
          target instanceof Element &&
          target.closest("button, input, textarea, select, a, .omni-select")
        ) {
          return;
        }
        event.preventDefault();
      }}
    >
      <div className="cm-sql-exec-target-picker__caption">
        {mode === "add" ? t("database.sqlTarget.add") : t("database.sqlTarget.editTitle")}
      </div>
      <label className="cm-sql-exec-target-picker__field">
        <span>{t("database.sqlTarget.connection")}</span>
        <Select
          className="db-select"
          size="sm"
          searchable
          panelMinWidth={240}
          panelZIndex={200020}
          value={connId}
          placeholder={t("database.sqlTarget.connection")}
          title={t("database.sqlTarget.connection")}
          options={connections.map((conn) => ({
            value: conn.id,
            label: conn.name,
            title: conn.name,
          }))}
          onChange={(value) => {
            setConnId(value);
            setDatabase("");
          }}
        />
      </label>
      <label className="cm-sql-exec-target-picker__field">
        <span>{t("database.sqlTarget.database")}</span>
        <Select
          className="db-select"
          size="sm"
          searchable
          panelMinWidth={240}
          panelZIndex={200020}
          value={database}
          disabled={!connId || loading}
          placeholder={
            loading ? t("common.loading") : t("database.sqlTarget.database")
          }
          emptyText={t("database.workspace.noDatabase")}
          title={t("database.sqlTarget.database")}
          options={
            databases.length === 0
              ? []
              : databases.map((name) => ({ value: name, label: name, title: name }))
          }
          onChange={setDatabase}
        />
      </label>
      <div className="cm-sql-exec-target-picker__actions">
        {canRemove ? (
          <WorkbenchActionButton danger onClick={onRemove}>
            {t("database.sqlTarget.remove")}
          </WorkbenchActionButton>
        ) : null}
        <WorkbenchActionButton
          disabled={!ready || unchanged}
          onClick={() => {
            if (!connId || !database) return;
            onCommit({ connId, database });
          }}
        >
          {mode === "add" ? t("database.sqlTarget.add") : t("database.sqlTarget.save")}
        </WorkbenchActionButton>
      </div>
    </div>
  );
}
