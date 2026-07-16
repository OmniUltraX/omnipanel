import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
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
import { IconSearch, IconShield, IconUser } from "../../../components/ui/icons/Icons";
import { makeQueryRunId } from "../sql/queryRun";
import {
  listConnectionUsers,
  listDatabases,
  type DbConnectionConfig,
  type DbUserMeta,
} from "../api";
import type { QueryResult } from "./dbWorkspaceState";
import {
  GrantsSummaryView,
  buildChangePasswordSql,
  buildCreateUserSql,
  buildDropUserSqlForEngine,
  buildGrantSql,
  buildRevokeSql,
  buildSetLoginEnabledSql,
  defaultScopeKind,
  loadGrantSummary,
  privilegeChipsFor,
  resolveUserEngine,
  scopeOptionsForEngine,
  userDisplayLabel,
  type GrantScopeKind,
  type GrantSummaryLine,
  type UserEngine,
} from "../users";

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

function userKey(u: DbUserMeta): string {
  return u.host ? `${u.name}@${u.host}` : u.name;
}

function userBadges(u: DbUserMeta): string[] {
  const badges: string[] = [];
  if (u.isRole) badges.push("ROLE");
  if (u.canLogin) badges.push("LOGIN");
  if (u.isSuperuser) badges.push("SUPERUSER");
  if (u.canCreateDb) badges.push("CREATEDB");
  if (u.accountLocked) badges.push("LOCKED");
  return badges;
}

interface ConnectionUsersTabPanelProps {
  connection: DbConnectionConfig;
  active: boolean;
  /** 父级搜索（连接信息顶栏）；工作台内另有独立搜索，二者任一命中即可 */
  search?: string;
  /** 父级点刷新时递增，触发重新拉取用户列表 */
  refreshNonce?: number;
  onActionsReady?: (actions: ReactNode | null) => void;
}

export function ConnectionUsersTabPanel({
  connection,
  active,
  search: externalSearch = "",
  refreshNonce = 0,
  onActionsReady,
}: ConnectionUsersTabPanelProps) {
  const { t } = useI18n();
  const engine = resolveUserEngine(connection.db_type);

  const [users, setUsers] = useState<DbUserMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listSearch, setListSearch] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);

  const [grantLines, setGrantLines] = useState<GrantSummaryLine[]>([]);
  const [grantsLoading, setGrantsLoading] = useState(false);
  const [grantsError, setGrantsError] = useState<string | null>(null);

  // 右栏编辑表单
  const [scopeKind, setScopeKind] = useState<GrantScopeKind>("database");
  const [selectedPrivs, setSelectedPrivs] = useState<string[]>(["CONNECT"]);
  const [dbName, setDbName] = useState("");
  const [schemaName, setSchemaName] = useState("public");
  const [tableName, setTableName] = useState("");
  const [withGrantOption, setWithGrantOption] = useState(false);
  const [databases, setDatabases] = useState<string[]>([]);
  const [editorBusy, setEditorBusy] = useState(false);
  const [editorStatus, setEditorStatus] = useState<string | null>(null);

  const refreshUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listConnectionUsers(connection);
      setUsers(result);
      setSelectedKey((prev) => {
        if (prev && result.some((u) => userKey(u) === prev)) return prev;
        return result[0] ? userKey(result[0]) : null;
      });
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

  useEffect(() => {
    if (!active || refreshNonce <= 0) return;
    void refreshUsers();
  }, [active, refreshNonce, refreshUsers]);

  useEffect(() => {
    if (!active || !engine) return;
    void listDatabases(connection)
      .then((dbs) => {
        setDatabases(dbs);
        setDbName((prev) => prev || dbs[0] || connection.database || "");
      })
      .catch(() => setDatabases([]));
  }, [active, connection, engine]);

  useEffect(() => {
    if (!engine) return;
    setScopeKind(defaultScopeKind(engine));
    setSelectedPrivs(
      engine === "postgres" ? ["CONNECT"] : ["SELECT"],
    );
    setWithGrantOption(false);
    setEditorStatus(null);
  }, [engine, selectedKey]);

  const selectedUser = useMemo(
    () => users.find((u) => userKey(u) === selectedKey) ?? null,
    [users, selectedKey],
  );

  const refreshGrants = useCallback(async () => {
    if (!selectedUser || !engine) {
      setGrantLines([]);
      return;
    }
    setGrantsLoading(true);
    setGrantsError(null);
    try {
      const { lines } = await loadGrantSummary(connection, selectedUser);
      setGrantLines(lines);
    } catch (e) {
      setGrantsError(typeof e === "string" ? e : JSON.stringify(e));
      setGrantLines([]);
    } finally {
      setGrantsLoading(false);
    }
  }, [connection, engine, selectedUser]);

  useEffect(() => {
    if (!active || !selectedUser) return;
    void refreshGrants();
  }, [active, selectedUser, refreshGrants]);

  const filteredUsers = useMemo(() => {
    const q = (listSearch || externalSearch).trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.name.toLowerCase().includes(q) ||
        (u.host ?? "").toLowerCase().includes(q) ||
        userBadges(u).some((b) => b.toLowerCase().includes(q)),
    );
  }, [users, listSearch, externalSearch]);

  const scopeOptions = useMemo(
    () => (engine ? scopeOptionsForEngine(engine) : []),
    [engine],
  );

  const privilegeChips = useMemo(
    () => (engine ? privilegeChipsFor(engine, scopeKind) : []),
    [engine, scopeKind],
  );

  useEffect(() => {
    const allowed = new Set(privilegeChips.map((c) => c.id));
    setSelectedPrivs((prev) => {
      const next = prev.filter((p) => allowed.has(p));
      if (next.length > 0) return next;
      return privilegeChips[0] ? [privilegeChips[0].id] : [];
    });
  }, [privilegeChips]);

  const previewSql = useMemo(() => {
    if (!engine || !selectedUser) return "";
    return (
      buildGrantSql(engine, {
        name: selectedUser.name,
        host: selectedUser.host,
        privileges: selectedPrivs,
        scopeKind,
        database: dbName,
        schema: schemaName,
        table: tableName,
        withGrantOption,
      }) ?? ""
    );
  }, [
    engine,
    selectedUser,
    selectedPrivs,
    scopeKind,
    dbName,
    schemaName,
    tableName,
    withGrantOption,
  ]);

  const handleDrop = useCallback(
    async (user: DbUserMeta) => {
      const label = userDisplayLabel(user.name, user.host);
      const confirmed = await appConfirm(
        t("database.connectionInfo.users.dropConfirm", { user: label }),
        t("database.connectionInfo.users.dropTitle"),
        { confirmLabel: t("database.connectionInfo.users.drop") },
      );
      if (!confirmed) return;
      const sql = buildDropUserSqlForEngine(connection.db_type, user.name, user.host);
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
      const sql = buildCreateUserSql(connection.db_type, name, password, host);
      if (!sql) throw new Error(t("database.connectionInfo.users.unsupportedEngine"));
      await executeSql(connection, sql);
      await refreshUsers();
    },
    [connection, refreshUsers, t],
  );

  const handleChangePassword = useCallback(
    async (user: DbUserMeta, newPassword: string) => {
      const sql = buildChangePasswordSql(
        connection.db_type,
        user.name,
        newPassword,
        user.host,
      );
      if (!sql) throw new Error(t("database.connectionInfo.users.unsupportedEngine"));
      await executeSql(connection, sql);
    },
    [connection, t],
  );

  const handleToggleLogin = useCallback(
    async (user: DbUserMeta, enabled: boolean) => {
      const sql = buildSetLoginEnabledSql(
        connection.db_type,
        user.name,
        enabled,
        user.host,
      );
      if (!sql) return;
      try {
        await executeSql(connection, sql);
        await refreshUsers();
        await refreshGrants();
      } catch (e) {
        void appAlert(
          typeof e === "string" ? e : JSON.stringify(e),
          t("database.connectionInfo.users.loginToggleFailed"),
        );
      }
    },
    [connection, refreshGrants, refreshUsers, t],
  );

  const handleGrant = useCallback(async () => {
    if (!previewSql || !selectedUser) return;
    setEditorBusy(true);
    setEditorStatus(null);
    try {
      await executeSql(connection, previewSql);
      setEditorStatus(t("database.connectionInfo.users.grantSuccess"));
      await refreshGrants();
      await refreshUsers();
    } catch (e) {
      setEditorStatus(typeof e === "string" ? e : JSON.stringify(e));
    } finally {
      setEditorBusy(false);
    }
  }, [connection, previewSql, refreshGrants, refreshUsers, selectedUser, t]);

  const handleRevokeLine = useCallback(
    async (line: GrantSummaryLine) => {
      if (!engine || !selectedUser || !line.revokePrivileges || !line.revokeScope) {
        return;
      }
      const confirmed = await appConfirm(
        t("database.connectionInfo.users.revokeConfirm", {
          priv: line.revokePrivileges,
          scope: line.revokeScope,
        }),
        t("database.connectionInfo.users.revokeTitle"),
        { confirmLabel: t("database.connectionInfo.users.revoke") },
      );
      if (!confirmed) return;
      const sql = buildRevokeSql(engine, {
        name: selectedUser.name,
        host: selectedUser.host,
        privileges: line.revokePrivileges,
        scopeSql: line.revokeScope,
      });
      if (!sql) return;
      try {
        await executeSql(connection, sql);
        await refreshGrants();
      } catch (e) {
        void appAlert(
          typeof e === "string" ? e : JSON.stringify(e),
          t("database.connectionInfo.users.revokeTitle"),
        );
      }
    },
    [connection, engine, refreshGrants, selectedUser, t],
  );

  const togglePriv = (id: string) => {
    setSelectedPrivs((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
    );
  };

  useEffect(() => {
    if (!onActionsReady) return;
    if (active) {
      onActionsReady(
        <Button variant="default" size="xs" onClick={() => setCreateOpen(true)}>
          {t("database.connectionInfo.users.create")}
        </Button>,
      );
    } else {
      onActionsReady(null);
    }
    return () => onActionsReady(null);
  }, [active, onActionsReady, t]);

  if (!engine) {
    return (
      <div className="db-tables-panel-empty">
        {t("database.connectionInfo.users.unsupportedEngine")}
      </div>
    );
  }

  if (loading && users.length === 0) {
    return <div className="db-tables-panel-empty">{t("common.loading")}</div>;
  }

  if (error) {
    return <div className="db-tables-panel-error">{error}</div>;
  }

  const loginEnabled = selectedUser
    ? selectedUser.accountLocked
      ? false
      : selectedUser.canLogin !== false
    : false;

  return (
    <div className="db-users-workbench">
      {/* 左：用户列表 */}
      <aside className="db-users-workbench-left">
        <div className="db-users-list-search">
          <IconSearch size={14} className="db-users-list-search-icon" />
          <input
            className="db-users-list-search-input"
            value={listSearch}
            onChange={(e) => setListSearch(e.target.value)}
            placeholder={t("database.connectionInfo.users.searchHost")}
          />
        </div>
        <div className="db-users-list" role="listbox">
          {filteredUsers.length === 0 ? (
            <div className="db-users-list-empty">
              {users.length === 0
                ? t("database.connectionInfo.users.empty")
                : t("database.connectionInfo.users.noResults")}
            </div>
          ) : (
            filteredUsers.map((u) => {
              const key = userKey(u);
              const activeItem = key === selectedKey;
              return (
                <button
                  key={key}
                  type="button"
                  role="option"
                  aria-selected={activeItem}
                  className={`db-users-list-item${activeItem ? " is-active" : ""}`}
                  onClick={() => setSelectedKey(key)}
                >
                  <IconUser size={14} className="db-users-list-item-icon" />
                  <div className="db-users-list-item-body">
                    <div className="db-users-list-item-name">
                      {u.name}
                      {u.host ? (
                        <span className="db-users-list-item-host">@{u.host}</span>
                      ) : null}
                    </div>
                    <div className="db-users-list-item-badges">
                      {userBadges(u).map((b) => (
                        <span key={b} className="db-users-badge">
                          {b}
                        </span>
                      ))}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </aside>

      {/* 中：摘要 + 操作 */}
      <section className="db-users-workbench-center">
        {selectedUser ? (
          <>
            <header className="db-users-center-header">
              <div className="db-users-center-title">
                <span className="db-users-center-name">{selectedUser.name}</span>
                {selectedUser.isRole || !selectedUser.canLogin ? (
                  <span className="db-users-badge">ROLE</span>
                ) : (
                  <span className="db-users-badge">USER</span>
                )}
                {selectedUser.host ? (
                  <span className="db-users-center-host">@{selectedUser.host}</span>
                ) : null}
              </div>
              <div className="db-users-center-actions">
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setPasswordOpen(true)}
                >
                  {t("database.connectionInfo.users.changePassword")}
                </Button>
                {loginEnabled ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => void handleToggleLogin(selectedUser, false)}
                  >
                    {t("database.connectionInfo.users.disableLogin")}
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => void handleToggleLogin(selectedUser, true)}
                  >
                    {t("database.connectionInfo.users.enableLogin")}
                  </Button>
                )}
                <Button
                  variant="danger"
                  size="xs"
                  onClick={() => void handleDrop(selectedUser)}
                >
                  {t("database.connectionInfo.users.drop")}
                </Button>
              </div>
            </header>
            <div className="db-users-center-section-label">
              <IconShield size={14} />
              {t("database.connectionInfo.users.authorization")}
            </div>
            <div className="db-users-center-body">
              {grantsLoading ? (
                <div className="db-users-grants-empty">{t("common.loading")}</div>
              ) : grantsError ? (
                <div className="db-tables-panel-error">{grantsError}</div>
              ) : (
                <GrantsSummaryView
                  lines={grantLines}
                  emptyText={t("database.connectionInfo.users.noGrants")}
                  onRevoke={(line) => void handleRevokeLine(line)}
                  revokeLabel={t("database.connectionInfo.users.revoke")}
                />
              )}
            </div>
          </>
        ) : (
          <div className="db-users-center-empty">
            {t("database.connectionInfo.users.selectUserHint")}
          </div>
        )}
      </section>

      {/* 右：权限编辑 */}
      <aside className="db-users-workbench-right">
        <h3 className="db-users-editor-title">
          {t("database.connectionInfo.users.editorTitle")}
        </h3>
        <p className="db-users-editor-hint">
          {t("database.connectionInfo.users.editorHint")}
        </p>
        {!selectedUser ? (
          <div className="db-users-editor-disabled">
            {t("database.connectionInfo.users.selectUserHint")}
          </div>
        ) : (
          <div className="db-users-editor-form">
            <label className="db-users-editor-field">
              <span>{t("database.connectionInfo.users.scope")}</span>
              <Select
                value={scopeKind}
                onChange={(v) => setScopeKind(v as GrantScopeKind)}
                options={scopeOptions.map((o) => ({
                  value: o.id,
                  label: t(
                    `database.connectionInfo.users.${o.labelKey}` as "database.connectionInfo.users.scopeDatabase",
                  ),
                }))}
              />
            </label>

            {(scopeKind === "database" ||
              scopeKind === "table" ||
              (engine === "mysql" && scopeKind !== "global")) && (
              <label className="db-users-editor-field">
                <span>{t("database.connectionInfo.users.database")}</span>
                <Select
                  value={dbName}
                  onChange={setDbName}
                  options={[
                    { value: "", label: t("database.connectionInfo.users.pickDatabase") },
                    ...databases.map((d) => ({ value: d, label: d })),
                  ]}
                />
              </label>
            )}

            {engine === "postgres" &&
              (scopeKind === "schema" || scopeKind === "table") && (
                <label className="db-users-editor-field">
                  <span>{t("database.connectionInfo.users.schema")}</span>
                  <TextInput
                    value={schemaName}
                    onChange={setSchemaName}
                    placeholder="public"
                  />
                </label>
              )}

            {scopeKind === "table" && (
              <label className="db-users-editor-field">
                <span>{t("database.connectionInfo.users.table")}</span>
                <TextInput
                  value={tableName}
                  onChange={setTableName}
                  placeholder={t("database.connectionInfo.users.table")}
                />
              </label>
            )}

            <div className="db-users-editor-field">
              <span>{t("database.connectionInfo.users.privilege")}</span>
              <div className="db-users-priv-chips">
                {privilegeChips.map((chip) => {
                  const on = selectedPrivs.includes(chip.id);
                  return (
                    <button
                      key={chip.id}
                      type="button"
                      className={`db-users-priv-chip${on ? " is-active" : ""}`}
                      onClick={() => togglePriv(chip.id)}
                    >
                      {chip.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <label className="db-users-editor-grant-opt">
              <input
                type="checkbox"
                checked={withGrantOption}
                onChange={(e) => setWithGrantOption(e.target.checked)}
              />
              {t("database.connectionInfo.users.withGrantOption")}
            </label>

            <div className="db-users-editor-preview">
              <div className="db-users-editor-preview-label">
                {t("database.connectionInfo.users.sqlPreview")}
              </div>
              <code className="db-users-editor-preview-sql">
                {previewSql || t("database.connectionInfo.users.sqlPreviewEmpty")}
              </code>
            </div>

            {editorStatus ? (
              <div className="db-users-editor-status">{editorStatus}</div>
            ) : null}

            <Button
              variant="default"
              size="sm"
              disabled={!previewSql || editorBusy}
              onClick={() => void handleGrant()}
            >
              {editorBusy
                ? t("common.saving")
                : t("database.connectionInfo.users.grant")}
            </Button>
          </div>
        )}
      </aside>

      {createOpen ? (
        <CreateUserDialog
          engine={engine}
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onSubmit={handleCreate}
        />
      ) : null}

      {passwordOpen && selectedUser ? (
        <ChangePasswordDialog
          user={selectedUser}
          open={passwordOpen}
          onClose={() => setPasswordOpen(false)}
          onSubmit={async (pwd) => {
            await handleChangePassword(selectedUser, pwd);
            setPasswordOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function CreateUserDialog({
  engine,
  open,
  onClose,
  onSubmit,
}: {
  engine: UserEngine;
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
      onClose();
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
        label: busy ? t("common.saving") : t("database.connectionInfo.users.create"),
        disabled: !canSubmit,
        onClick: () => void handleSubmit(),
      }}
    >
      <FormField label={t("database.connectionInfo.users.userName")} htmlFor="cu-name">
        <TextInput id="cu-name" value={name} onChange={setName} autoFocus />
      </FormField>
      {engine === "mysql" ? (
        <FormField label={t("database.connectionInfo.users.host")} htmlFor="cu-host">
          <TextInput id="cu-host" value={host} onChange={setHost} placeholder="%" />
        </FormField>
      ) : null}
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
        user: userDisplayLabel(user.name, user.host),
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
      <FormField label={t("database.connectionInfo.users.newPassword")} htmlFor="cp-pwd">
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
