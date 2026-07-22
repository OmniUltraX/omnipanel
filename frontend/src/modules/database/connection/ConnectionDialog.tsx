import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useI18n } from "../../../i18n";
import { FormDialog, FormField } from "../../../components/ui/form/FormDialog";
import { PasswordInput } from "../../../components/ui/form/PasswordInput";
import { TextInput } from "../../../components/ui/form/TextInput";
import { useSettingsStore } from "../../../stores/settingsStore";
import type { FormFillFieldDef, FormFillValue } from "../../../components/ai/simple/formFill";
import type { DbConnectionConfig } from "../api";
import {
  type ConnectionFormData,
  connectionToForm,
  formToConnection,
  isSupportedEngine,
  saveConnection,
  testConnection,
} from "../api";
import { submitSchemaCacheRefresh } from "../schema/schemaCacheBackgroundTasks";
import { createSchemaCacheRefreshReporter } from "../schema/schemaCacheStatusLog";
import { getEngineIcon, type DbEngine } from "./engineIcons";
import { commands } from "../../../ipc/bindings";
import { unwrapCommand } from "../../../ipc/result";
import { GlobalTagEditor } from "../../tags/GlobalTagEditor";

const ENGINE_DEFAULTS: Record<DbEngine, { port: string; icon: string }> = {
  postgresql: { port: "5432", icon: "PG" },
  mysql: { port: "3306", icon: "MY" },
  sqlite: { port: "", icon: "SL" },
  sqlserver: { port: "1433", icon: "MS" },
  redis: { port: "6379", icon: "RE" },
  mongodb: { port: "27017", icon: "MG" },
  qdrant: { port: "6333", icon: "QD" },
};

const ENGINE_ALIASES: Record<string, DbEngine> = {
  mysql: "mysql",
  mariadb: "mysql",
  postgresql: "postgresql",
  postgres: "postgresql",
  pg: "postgresql",
  sqlite: "sqlite",
  sqlserver: "sqlserver",
  mssql: "sqlserver",
  "sql server": "sqlserver",
  redis: "redis",
  mongodb: "mongodb",
  mongo: "mongodb",
  qdrant: "qdrant",
};

function resolveEngineFromAi(raw: FormFillValue): DbEngine | null {
  const normalized = String(raw).trim().toLowerCase();
  const alias = ENGINE_ALIASES[normalized];
  if (alias) {
    return alias;
  }
  if (normalized in ENGINE_DEFAULTS) {
    return normalized as DbEngine;
  }
  return null;
}

const EMPTY_FORM: ConnectionFormData = {
  engine: "mysql",
  name: "",
  host: "localhost",
  port: "3306",
  database: "",
  username: "",
  password: "",
  ssl: false,
  group: "默认",
};

interface ConnectionDialogProps {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
  /** 传入已有连接表示编辑模式，表单会回显该连接数据。 */
  initialConnection?: DbConnectionConfig | null;
}

export function ConnectionDialog({
  open,
  onClose,
  onSaved,
  initialConnection,
}: ConnectionDialogProps) {
  const { t } = useI18n();
  const resolvedTheme = useSettingsStore((s) => s.resolved);
  const [form, setForm] = useState<ConnectionFormData>({ ...EMPTY_FORM });
  const [tags, setTags] = useState<string[]>([]);
  const [status, setStatus] = useState<{ kind: "info" | "success" | "error"; message: string } | null>(
    null
  );
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  const isEditMode = Boolean(initialConnection);

  const schemaCacheReporter = useMemo(() => createSchemaCacheRefreshReporter(t), [t]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setForm(
      initialConnection
        ? connectionToForm(initialConnection)
        : { ...EMPTY_FORM }
    );
    setStatus(null);
    setTesting(false);
    setSaving(false);
    if (initialConnection?.id) {
      let cancelled = false;
      void unwrapCommand(commands.resourceListTags("connection", initialConnection.id))
        .then((list) => {
          if (!cancelled) {
            setTags(list.filter((x) => x.source !== "system").map((x) => x.tag.path));
          }
        })
        .catch(() => {
          if (!cancelled) setTags([]);
        });
      return () => {
        cancelled = true;
      };
    }
    setTags([]);
  }, [open, initialConnection]);

  const update = <K extends keyof ConnectionFormData>(key: K, value: ConnectionFormData[K]) => {
    setStatus(null);
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleEngineChange = (engine: DbEngine) => {
    setStatus(null);
    setForm((prev) => ({
      ...prev,
      engine,
      port: ENGINE_DEFAULTS[engine].port,
    }));
  };

  const validateForm = (): string | null => {
    // 编辑回显时部分字段可能缺省（如后端无 group），统一按空串校验
    const name = form.name ?? "";
    const host = form.host ?? "";
    const database = form.database ?? "";
    if (!name.trim() && form.engine !== "sqlite") {
      return t("database.dialog.nameRequired");
    }
    if (!isSupportedEngine(form.engine)) {
      return t("database.dialog.unsupportedEngine");
    }
    if (form.engine === "sqlite") {
      if (!database.trim()) {
        return t("database.dialog.databasePathRequired");
      }
    } else if (!host.trim()) {
      return t("database.dialog.hostRequired");
    }
    return null;
  };

  const handleBrowseDatabaseFile = useCallback(async () => {
    const selected = await openFileDialog({
      multiple: false,
      filters: [
        { name: "SQLite", extensions: ["db", "sqlite", "sqlite3", "db3"] },
      ],
    });
    if (typeof selected === "string" && selected.trim()) {
      setStatus(null);
      setForm((prev) => {
        const next = { ...prev, database: selected };
        if (!next.name.trim()) {
          const base = selected.split(/[/\\]/).pop();
          if (base) {
            next.name = base;
          }
        }
        return next;
      });
    }
  }, []);

  const handleSave = async () => {
    const validationError = validateForm();
    if (validationError) {
      setStatus({ kind: "error", message: validationError });
      return;
    }

    setSaving(true);
    setStatus(null);
    try {
      const saved = await saveConnection(formToConnection(form, initialConnection?.id ?? ""));
      await unwrapCommand(commands.resourceSetTags("connection", saved.id, tags));
      void submitSchemaCacheRefresh([saved.id], schemaCacheReporter);

      onSaved?.();
      onClose();
    } catch (error) {
      setStatus({
        kind: "error",
        message: t("database.dialog.saveFailed", { error: String(error) }),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    const validationError = validateForm();
    if (validationError) {
      setStatus({ kind: "error", message: validationError });
      return;
    }

    setTesting(true);
    setStatus({ kind: "info", message: t("database.dialog.testing") });
    try {
      const version = await testConnection(formToConnection(form));
      setStatus({
        kind: "success",
        message: t("database.dialog.testSuccess", { version }),
      });
    } catch (error) {
      setStatus({
        kind: "error",
        message: t("database.dialog.testFailed", { error: String(error) }),
      });
    } finally {
      setTesting(false);
    }
  };

  const isFileBased = form.engine === "sqlite";
  const busy = testing || saving;

  const aiFillFields = useMemo<FormFillFieldDef[]>(
    () => [
      { key: "name", label: t("database.dialog.name") },
      {
        key: "engine",
        label: t("database.dialog.engine"),
        description: "mysql, postgresql, sqlite, sqlserver, redis, mongodb, qdrant",
      },
      { key: "host", label: t("database.dialog.host") },
      { key: "port", label: t("database.dialog.port"), type: "number" },
      { key: "database", label: t("database.dialog.database") },
      { key: "username", label: t("database.dialog.username") },
      { key: "password", label: t("database.dialog.password") },
    ],
    [t],
  );

  const handleAiFill = useCallback((values: Record<string, FormFillValue>) => {
    setStatus(null);
    setForm((prev) => {
      const next = { ...prev };
      for (const [key, raw] of Object.entries(values)) {
        if (raw === null || raw === undefined || raw === "") {
          continue;
        }
        if (key === "engine") {
          const typed = resolveEngineFromAi(raw);
          if (typed) {
            next.engine = typed;
            if (!values.port) {
              next.port = ENGINE_DEFAULTS[typed].port;
            }
          }
          continue;
        }
        if (key === "ssl") {
          next.ssl = Boolean(raw);
          continue;
        }
        if (key === "port") {
          next.port = String(raw);
          continue;
        }
        if (key in next) {
          (next as Record<string, unknown>)[key] = String(raw);
        }
      }
      if (!(next.name ?? "").trim() && (next.host ?? "").trim()) {
        next.name = (next.host ?? "").trim();
      }
      return next;
    });
  }, []);

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={t(isEditMode ? "database.dialog.editTitle" : "database.dialog.title")}
      onCancel={onClose}
      cancelDisabled={busy}
      status={status}
      aiFillFields={aiFillFields}
      onAiFill={handleAiFill}
      actions={[
        {
          label: testing ? t("database.dialog.testing") : t("database.dialog.test"),
          variant: "ghost",
          disabled: busy,
          onClick: () => void handleTest(),
        },
      ]}
      primaryAction={{
        label: saving ? t("database.dialog.saving") : t("database.dialog.save"),
        disabled: busy,
        onClick: () => void handleSave(),
      }}
    >
          <FormField label={t("database.dialog.engine")} description={t("database.dialog.engineDescription")}>
            <div className="engine-grid">
              {(Object.keys(ENGINE_DEFAULTS) as DbEngine[])
                .filter(isSupportedEngine)
                .map((engine) => {
                const iconUrl = getEngineIcon(engine, resolvedTheme);
                return (
                  <button
                    key={engine}
                    className={`engine-chip${form.engine === engine ? " engine-chip--active" : ""}`}
                    onClick={() => handleEngineChange(engine)}
                  >
                    <span className="engine-chip-icon">
                      {iconUrl ? (
                        <img
                          src={iconUrl}
                          alt=""
                          className="engine-chip-logo"
                          draggable={false}
                        />
                      ) : (
                        ENGINE_DEFAULTS[engine].icon
                      )}
                    </span>
                    <span className="engine-chip-label">{engine}</span>
                  </button>
                );
              })}
            </div>
          </FormField>

          <FormField
            label={t("database.dialog.name")}
            htmlFor="db-conn-name"
            description={t("database.dialog.nameDescription")}
          >
            <TextInput
              id="db-conn-name"
              className="input"
              placeholder={t("database.dialog.namePlaceholder")}
              value={form.name}
              onChange={(value) => update("name", value)}
            />
          </FormField>

          {!isFileBased && (
            <div className="form-row">
              <div style={{ flex: 2 }}>
                <FormField
                  label={t("database.dialog.host")}
                  htmlFor="db-conn-host"
                  description={t("database.dialog.hostDescription")}
                >
                  <TextInput
                    id="db-conn-host"
                    className="input"
                    placeholder="localhost"
                    value={form.host}
                    onChange={(value) => update("host", value)}
                  />
                </FormField>
              </div>
              <div style={{ flex: 1 }}>
                <FormField
                  label={t("database.dialog.port")}
                  htmlFor="db-conn-port"
                  description={t("database.dialog.portDescription")}
                >
                  <TextInput
                    id="db-conn-port"
                    className="input"
                    placeholder={ENGINE_DEFAULTS[form.engine].port}
                    value={form.port}
                    onChange={(value) => update("port", value)}
                  />
                </FormField>
              </div>
            </div>
          )}

          {form.engine !== "qdrant" ? (
          <FormField
            label={
              <>
                {t("database.dialog.database")}
                {!isFileBased && form.engine !== "redis" && (
                  <span style={{ marginLeft: 6, fontWeight: 400, opacity: 0.6 }}>
                    ({t("database.dialog.optional")})
                  </span>
                )}
              </>
            }
            htmlFor="db-conn-database"
            description={t("database.dialog.databaseDescription")}
          >
            <div className={isFileBased ? "form-row form-row--align-end" : undefined}>
              <TextInput
                id="db-conn-database"
                className="input"
                style={isFileBased ? { flex: 1 } : undefined}
                placeholder={
                  isFileBased
                    ? "/path/to/file.db"
                    : form.engine === "redis"
                      ? "0"
                      : t("database.dialog.databasePlaceholder")
                }
                value={form.database}
                onChange={(value) => update("database", value)}
              />
              {isFileBased ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void handleBrowseDatabaseFile()}
                >
                  {t("database.dialog.browseDatabaseFile")}
                </button>
              ) : null}
            </div>
          </FormField>
          ) : null}

          {!isFileBased && (
            <div className="form-row">
              {form.engine !== "qdrant" ? (
                <div style={{ flex: 1 }}>
                  <FormField
                    label={t("database.dialog.username")}
                    htmlFor="db-conn-username"
                    description={t("database.dialog.usernameDescription")}
                  >
                    <TextInput
                      id="db-conn-username"
                      className="input"
                      placeholder={form.engine === "redis" ? "default" : "postgres"}
                      value={form.username}
                      onChange={(value) => update("username", value)}
                    />
                  </FormField>
                </div>
              ) : null}
              <div style={{ flex: 1 }}>
                <FormField
                  label={
                    form.engine === "qdrant"
                      ? t("database.dialog.apiKey")
                      : t("database.dialog.password")
                  }
                  htmlFor="db-conn-password"
                  description={
                    form.engine === "qdrant"
                      ? t("database.dialog.apiKeyDescription")
                      : t("database.dialog.passwordDescription")
                  }
                >
                  <PasswordInput
                    copyable
                    value={form.password}
                    onChange={(value) => update("password", value)}
                    placeholder="••••••"
                  />
                </FormField>
              </div>
            </div>
          )}

          {!isFileBased && form.engine !== "redis" && (
            <FormField
              label={t("database.dialog.ssl")}
              description={t("database.dialog.sslDescription")}
            >
              <label className="form-check">
                <input
                  type="checkbox"
                  checked={form.ssl}
                  onChange={(e) => update("ssl", e.target.checked)}
                />
                <span>{t("database.dialog.ssl")}</span>
              </label>
            </FormField>
          )}

          <FormField label={t("resourceTags.section")}>
            <GlobalTagEditor
              kind="connection"
              resourceId={initialConnection?.id ?? ""}
              tags={tags}
              onChange={setTags}
            />
          </FormField>

    </FormDialog>
  );
}
