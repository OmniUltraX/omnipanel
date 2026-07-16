import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../../i18n";
import { appConfirm } from "../../../lib/appConfirm";
import { appAlert } from "../../../lib/appAlert";
import { Button } from "../../../components/ui/primitives/Button";
import {
  FormDialog,
  FormField,
} from "../../../components/ui/form/FormDialog";
import { TextInput, PasswordInput, Select } from "../../../components/ui/form";
import {
  DbTablesPanelGrid,
  type DbTablesPanelGridColumn,
} from "./DbTablesPanelGrid";
import { makeQueryRunId } from "../sql/queryRun";
import {
  listConnectionUsers,
  listDatabases,
  type DbConnectionConfig,
  type DbUserMeta,
} from "../api";
import { buildDropUserSql } from "../schema/schemaTreeDropSql";
import type { QueryResult } from "./dbWorkspaceState";

/* ---------- SQL helpers ---------- */

function quoteUserPart(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteId(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

function formatUserHost(name: string, host?: string | null): string {
  const h = (host ?? "%").trim() || "%";
  return `${quoteUserPart(name)}@${quoteUserPart(h)}`;
}

async function executeSql(
  connection: DbConnectionConfig,
  sql: string,
): Promise<QueryResult> {
  return invoke<QueryResult>("db_execute_query", {
    connection,
    sql,
    runId: makeQueryRunId(),
  });
}

/* ---------- Grant parsing ---------- */

interface ParsedGrant {
  privilege: string;
  scope: string;
}

/** Parse a `GRANT ... ON ... TO ...` string into privilege + scope. */
function parseGrantString(grant: string): ParsedGrant | null {
  const m = grant.match(/^GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+/i);
  if (!m) return null;
  return { privilege: m[1].trim(), scope: m[2].trim() };
}

/* ---------- Privilege options ---------- */

const PRIVILEGE_OPTIONS = [
  "ALL PRIVILEGES",
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "CREATE",
  "DROP",
  "ALTER",
  "INDEX",
  "REFERENCES",
  "GRANT OPTION",
  "RELOAD",
  "PROCESS",
  "REPLICATION CLIENT",
  "REPLICATION SLAVE",
  "SHOW DATABASES",
  "SHUTDOWN",
  "SUPER",
  "USAGE",
];

/* ---------- Component ---------- */

interface ConnectionUsersTabPanelProps {
  connection: DbConnectionConfig;
  active: boolean;
  search: string;
  /** 暴露操作按钮给外部（底部 meta 栏），避免顶部工具栏挤占列表空间 */
  onActionsReady?: (actions: ReactNode | null) => void;
}

export function ConnectionUsersTabPanel({
  connection,
  active,
  search,
  onActionsReady,
}: ConnectionUsersTabPanelProps) {
  const { t } = useI18n();
  const [users, setUsers] = useState<DbUserMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [passwordTarget, setPasswordTarget] = useState<DbUserMeta | null>(null);
  const [grantsTarget, setGrantsTarget] = useState<DbUserMeta | null>(null);

  const refreshUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listConnectionUsers(connection);
      setUsers(result);
    } catch (e) {
      setError(typeof e === "string" ? e : JSON.stringify(e));
    } finally {
      setLoading(false);
    }
  }, [connection]);

  useEffect(() => {
    if (!active) return;
    void refreshUsers();
  }, [active, refreshUsers]);

  /* ----- Actions ----- */

  const handleDrop = useCallback(
    async (user: DbUserMeta) => {
      const label = user.host
        ? `${user.name}@${user.host}`
        : user.name;
      const confirmed = await appConfirm(
        t("database.connectionInfo.users.dropConfirm", { user: label }),
        t("database.connectionInfo.users.dropTitle"),
        { confirmLabel: t("database.connectionInfo.users.drop") },
      );
      if (!confirmed) return;
      const sql = buildDropUserSql(connection.db_type, user.name, user.host);
      if (!sql) return;
      try {
        await executeSql(connection, sql);
        await refreshUsers();
      } catch (e) {
        void appAlert(
          typeof e === "string" ? e : JSON.stringify(e),
          t("database.connectionInfo.users.dropFailed"),
        );
      }
    },
    [connection, refreshUsers, t],
  );

  const handleCreate = useCallback(
    async (name: string, host: string, password: string) => {
      const sql = `CREATE USER ${formatUserHost(name, host)} IDENTIFIED BY ${quoteUserPart(password)};`;
      await executeSql(connection, sql);
      await refreshUsers();
    },
    [connection, refreshUsers],
  );

  const handleChangePassword = useCallback(
    async (user: DbUserMeta, newPassword: string) => {
      const sql = `ALTER USER ${formatUserHost(user.name, user.host)} IDENTIFIED BY ${quoteUserPart(newPassword)};`;
      await executeSql(connection, sql);
    },
    [connection],
  );

  const handleGrant = useCallback(
    async (user: DbUserMeta, privilege: string, scope: string) => {
      const sql = `GRANT ${privilege} ON ${scope} TO ${formatUserHost(user.name, user.host)};`;
      await executeSql(connection, sql);
    },
    [connection],
  );

  const handleRevoke = useCallback(
    async (user: DbUserMeta, privilege: string, scope: string) => {
      const sql = `REVOKE ${privilege} ON ${scope} FROM ${formatUserHost(user.name, user.host)};`;
      await executeSql(connection, sql);
    },
    [connection],
  );

  /* ----- Filtered users ----- */

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.name.toLowerCase().includes(q) ||
        (u.host ?? "").toLowerCase().includes(q),
    );
  }, [users, search]);

  /* ----- Grid columns ----- */

  const columns = useMemo<DbTablesPanelGridColumn<DbUserMeta>[]>(
    () => [
      {
        id: "name",
        header: t("database.connectionInfo.users.colName"),
        sortable: true,
        sortId: "name",
        nameCell: true,
        render: (u) => u.name,
        getTitle: (u) => u.name,
        getCopyValue: (u) => u.name,
      },
      {
        id: "host",
        header: t("database.connectionInfo.users.colHost"),
        sortable: true,
        sortId: "host",
        render: (u) => u.host ?? "%",
        getTitle: (u) => u.host ?? "%",
        getCopyValue: (u) => u.host ?? "%",
      },
      {
        id: "__actions",
        variant: "actionsSticky" as const,
        header: t("database.connectionInfo.users.colActions"),
        headerAriaLabel: t("database.connectionInfo.users.colActions"),
        render: (u) => (
          <div className="db-user-actions">
            <Button
              variant="ghost"
              size="xs"
              onClick={(e) => {
                e.stopPropagation();
                setPasswordTarget(u);
              }}
            >
              {t("database.connectionInfo.users.changePassword")}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={(e) => {
                e.stopPropagation();
                setGrantsTarget(u);
              }}
            >
              {t("database.connectionInfo.users.privileges")}
            </Button>
            <Button
              variant="danger"
              size="xs"
              onClick={(e) => {
                e.stopPropagation();
                void handleDrop(u);
              }}
            >
              {t("database.connectionInfo.users.drop")}
            </Button>
          </div>
        ),
      },
    ],
    [handleDrop, t],
  );

  /* ----- 通过回调暴露「添加用户」按钮给外部底部 meta 栏 ----- */
  // 必须在所有 early return 之前调用，避免 hooks 顺序不一致
  useEffect(() => {
    if (!onActionsReady) return;
    if (active) {
      onActionsReady(
        <Button
          variant="default"
          size="xs"
          onClick={() => setCreateOpen(true)}
        >
          {t("database.connectionInfo.users.create")}
        </Button>,
      );
    } else {
      onActionsReady(null);
    }
    return () => onActionsReady(null);
  }, [active, onActionsReady, t]);

  /* ----- Render ----- */

  if (loading && users.length === 0) {
    return <div className="db-tables-panel-empty">{t("common.loading")}</div>;
  }
  if (error) {
    return <div className="db-tables-panel-error">{error}</div>;
  }
  if (users.length === 0) {
    return (
      <div className="db-tables-panel-empty">
        {t("database.connectionInfo.users.empty")}
      </div>
    );
  }
  if (filteredUsers.length === 0) {
    return (
      <div className="db-tables-panel-empty">
        {t("database.connectionInfo.users.noResults")}
      </div>
    );
  }

  return (
    <>
      <DbTablesPanelGrid
        variant="processlist"
        columns={columns}
        rows={filteredUsers}
        rowKey={(u, i) => `${u.name}@${u.host ?? "%"}_${i}`}
        columnResizeStorageKey={`db-conn-info-users-${connection.id}`}
      />
      {createOpen ? (
        <CreateUserDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onSubmit={async (name, host, password) => {
            try {
              await handleCreate(name, host, password);
              setCreateOpen(false);
            } catch (e) {
              void appAlert(
                typeof e === "string" ? e : JSON.stringify(e),
                t("database.connectionInfo.users.createFailed"),
              );
            }
          }}
        />
      ) : null}
      {passwordTarget ? (
        <ChangePasswordDialog
          user={passwordTarget}
          open={!!passwordTarget}
          onClose={() => setPasswordTarget(null)}
          onSubmit={async (newPassword) => {
            try {
              await handleChangePassword(passwordTarget, newPassword);
              setPasswordTarget(null);
            } catch (e) {
              void appAlert(
                typeof e === "string" ? e : JSON.stringify(e),
                t("database.connectionInfo.users.passwordChangeFailed"),
              );
            }
          }}
        />
      ) : null}
      {grantsTarget ? (
        <GrantsDialog
          user={grantsTarget}
          connection={connection}
          open={!!grantsTarget}
          onClose={() => setGrantsTarget(null)}
          onGrant={handleGrant}
          onRevoke={handleRevoke}
        />
      ) : null}
    </>
  );
}

/* ---------- Create User Dialog ---------- */

function CreateUserDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (name: string, host: string, password: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [host, setHost] = useState("%");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{
    kind: "info" | "success" | "error";
    message: string;
  } | null>(null);

  const canSubmit = name.trim().length > 0 && password.length > 0 && !busy;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setStatus(null);
    try {
      await onSubmit(name.trim(), host.trim() || "%", password);
    } catch (e) {
      setStatus({
        kind: "error",
        message: typeof e === "string" ? e : JSON.stringify(e),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={t("database.connectionInfo.users.createTitle")}
      size="sm"
      status={status}
      cancelDisabled={busy}
      cancelLabel={t("common.cancel")}
      onCancel={onClose}
      primaryAction={{
        label: busy
          ? t("common.saving")
          : t("database.connectionInfo.users.create"),
        disabled: !canSubmit,
        onClick: () => void handleSubmit(),
      }}
    >
      <FormField label={t("database.connectionInfo.users.userName")} htmlFor="cu-name">
        <TextInput
          id="cu-name"
          value={name}
          onChange={setName}
          placeholder="root"
        />
      </FormField>
      <FormField label={t("database.connectionInfo.users.host")} htmlFor="cu-host">
        <TextInput
          id="cu-host"
          value={host}
          onChange={setHost}
          placeholder="%"
        />
      </FormField>
      <FormField label={t("database.connectionInfo.users.password")} htmlFor="cu-pwd">
        <PasswordInput
          id="cu-pwd"
          value={password}
          onChange={setPassword}
          placeholder="••••••••"
        />
      </FormField>
    </FormDialog>
  );
}

/* ---------- Change Password Dialog ---------- */

function ChangePasswordDialog({
  user,
  open,
  onClose,
  onSubmit,
}: {
  user: DbUserMeta;
  open: boolean;
  onClose: () => void;
  onSubmit: (newPassword: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{
    kind: "info" | "success" | "error";
    message: string;
  } | null>(null);

  const canSubmit = password.length > 0 && !busy;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setStatus(null);
    try {
      await onSubmit(password);
    } catch (e) {
      setStatus({
        kind: "error",
        message: typeof e === "string" ? e : JSON.stringify(e),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={t("database.connectionInfo.users.changePasswordTitle", {
        user: user.host ? `${user.name}@${user.host}` : user.name,
      })}
      size="sm"
      status={status}
      cancelDisabled={busy}
      cancelLabel={t("common.cancel")}
      onCancel={onClose}
      primaryAction={{
        label: busy
          ? t("common.saving")
          : t("database.connectionInfo.users.changePassword"),
        disabled: !canSubmit,
        onClick: () => void handleSubmit(),
      }}
    >
      <FormField
        label={t("database.connectionInfo.users.newPassword")}
        htmlFor="cp-pwd"
      >
        <PasswordInput
          id="cp-pwd"
          value={password}
          onChange={setPassword}
          placeholder="••••••••"
        />
      </FormField>
    </FormDialog>
  );
}

/* ---------- Grants Dialog ---------- */

function GrantsDialog({
  user,
  connection,
  open,
  onClose,
  onGrant,
  onRevoke,
}: {
  user: DbUserMeta;
  connection: DbConnectionConfig;
  open: boolean;
  onClose: () => void;
  onGrant: (user: DbUserMeta, privilege: string, scope: string) => Promise<void>;
  onRevoke: (user: DbUserMeta, privilege: string, scope: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [grants, setGrants] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Grant form state
  const [privilege, setPrivilege] = useState("SELECT");
  const [scopeType, setScopeType] = useState<"global" | "database" | "table">(
    "global",
  );
  const [dbName, setDbName] = useState("");
  const [tableName, setTableName] = useState("");
  const [databases, setDatabases] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{
    kind: "info" | "success" | "error";
    message: string;
  } | null>(null);

  const userLabel = user.host ? `${user.name}@${user.host}` : user.name;

  const refreshGrants = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await executeSql(
        connection,
        `SHOW GRANTS FOR ${formatUserHost(user.name, user.host)};`,
      );
      const rows = result.rows.map((row) => String(row[0] ?? ""));
      setGrants(rows);
    } catch (e) {
      setError(typeof e === "string" ? e : JSON.stringify(e));
    } finally {
      setLoading(false);
    }
  }, [connection, user.name, user.host]);

  useEffect(() => {
    if (!open) return;
    void refreshGrants();
  }, [open, refreshGrants]);

  useEffect(() => {
    if (scopeType !== "global") {
      void listDatabases(connection)
        .then(setDatabases)
        .catch(() => setDatabases([]));
    }
  }, [connection, scopeType]);

  const currentScope = useMemo(() => {
    if (scopeType === "global") return "*.*";
    if (scopeType === "database") {
      if (!dbName) return null;
      return `${quoteId(dbName)}.*`;
    }
    if (!dbName || !tableName.trim()) return null;
    return `${quoteId(dbName)}.${quoteId(tableName.trim())}`;
  }, [scopeType, dbName, tableName]);

  const canGrant = !!currentScope && !busy;

  const handleGrant = async () => {
    if (!canGrant || !currentScope) return;
    setBusy(true);
    setStatus(null);
    try {
      await onGrant(user, privilege, currentScope);
      setStatus({ kind: "success", message: t("database.connectionInfo.users.grantSuccess") });
      await refreshGrants();
    } catch (e) {
      setStatus({
        kind: "error",
        message: typeof e === "string" ? e : JSON.stringify(e),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async (grantStr: string) => {
    const parsed = parseGrantString(grantStr);
    if (!parsed) return;
    const confirmed = await appConfirm(
      t("database.connectionInfo.users.revokeConfirm", {
        priv: parsed.privilege,
        scope: parsed.scope,
      }),
      t("database.connectionInfo.users.revokeTitle"),
      { confirmLabel: t("database.connectionInfo.users.revoke") },
    );
    if (!confirmed) return;
    setBusy(true);
    setStatus(null);
    try {
      await onRevoke(user, parsed.privilege, parsed.scope);
      setStatus({ kind: "success", message: t("database.connectionInfo.users.revokeSuccess") });
      await refreshGrants();
    } catch (e) {
      setStatus({
        kind: "error",
        message: typeof e === "string" ? e : JSON.stringify(e),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={t("database.connectionInfo.users.privilegesTitle", { user: userLabel })}
      size="md"
      status={status}
      cancelDisabled={busy}
      cancelLabel={t("common.close")}
      onCancel={onClose}
    >
      {/* Current grants */}
      <div className="db-grants-section">
        <div className="db-grants-section-title">
          {t("database.connectionInfo.users.currentGrants")}
        </div>
        {loading ? (
          <div className="db-tables-panel-empty">{t("common.loading")}</div>
        ) : error ? (
          <div className="db-tables-panel-error">{error}</div>
        ) : grants.length === 0 ? (
          <div className="db-tables-panel-empty">
            {t("database.connectionInfo.users.noGrants")}
          </div>
        ) : (
          <ul className="db-grants-list">
            {grants.map((g, i) => {
              const parsed = parseGrantString(g);
              return (
                <li key={i} className="db-grants-list-item">
                  <code className="db-grants-list-code">{g}</code>
                  {parsed ? (
                    <Button
                      variant="danger"
                      size="xs"
                      disabled={busy}
                      onClick={() => void handleRevoke(g)}
                    >
                      {t("database.connectionInfo.users.revoke")}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Grant form */}
      <div className="db-grants-section">
        <div className="db-grants-section-title">
          {t("database.connectionInfo.users.grantNew")}
        </div>
        <FormField
          label={t("database.connectionInfo.users.privilege")}
          htmlFor="gr-priv"
        >
          <Select
            value={privilege}
            onChange={setPrivilege}
            options={PRIVILEGE_OPTIONS}
            size="sm"
          />
        </FormField>
        <FormField
          label={t("database.connectionInfo.users.scope")}
          htmlFor="gr-scope"
        >
          <Select
            value={scopeType}
            onChange={(v) => setScopeType(v as typeof scopeType)}
            options={[
              {
                value: "global",
                label: t("database.connectionInfo.users.scopeGlobal"),
              },
              {
                value: "database",
                label: t("database.connectionInfo.users.scopeDatabase"),
              },
              {
                value: "table",
                label: t("database.connectionInfo.users.scopeTable"),
              },
            ]}
            size="sm"
          />
        </FormField>
        {scopeType !== "global" ? (
          <FormField
            label={t("database.connectionInfo.users.database")}
            htmlFor="gr-db"
          >
            <Select
              value={dbName}
              onChange={setDbName}
              options={databases}
              searchable
              size="sm"
            />
          </FormField>
        ) : null}
        {scopeType === "table" ? (
          <FormField
            label={t("database.connectionInfo.users.table")}
            htmlFor="gr-tbl"
          >
            <TextInput
              id="gr-tbl"
              value={tableName}
              onChange={setTableName}
              placeholder="table_name"
              size="sm"
            />
          </FormField>
        ) : null}
        <div className="db-grants-actions">
          <Button
            variant="default"
            size="sm"
            disabled={!canGrant}
            onClick={() => void handleGrant()}
          >
            {busy
              ? t("common.saving")
              : t("database.connectionInfo.users.grant")}
          </Button>
          {currentScope ? (
            <code className="db-grants-preview">
              GRANT {privilege} ON {currentScope} TO {formatUserHost(user.name, user.host)}
            </code>
          ) : null}
        </div>
      </div>
    </FormDialog>
  );
}
