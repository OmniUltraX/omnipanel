import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { FormDialog, FormField } from "../../components/ui/FormDialog";
import { Select } from "../../components/ui/Select";
import { useSettingsStore } from "../../stores/settingsStore";
import type { FormFillFieldDef, FormFillValue } from "../../components/ai/simple/formFill";
import type { DbConnectionGroup } from "../../stores/dbGroupStore";
import type { DbConnectionConfig } from "./api";
import {
  type ConnectionFormData,
  connectionToForm,
  formToConnection,
  isSupportedEngine,
  saveConnection,
  testConnection,
} from "./api";
import { refreshAndPatchConnectionSchemaCache } from "./schemaCacheRefresh";
import { createSchemaCacheRefreshReporter } from "./schemaCacheStatusLog";
import { getEngineIcon, type DbEngine } from "./engineIcons";

const ENGINE_DEFAULTS: Record<DbEngine, { port: string; icon: string }> = {
  postgresql: { port: "5432", icon: "PG" },
  mysql: { port: "3306", icon: "MY" },
  sqlite: { port: "", icon: "SL" },
  sqlserver: { port: "1433", icon: "MS" },
  redis: { port: "6379", icon: "RE" },
  mongodb: { port: "27017", icon: "MG" },
};

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
  defaultGroup?: string;
  groups?: DbConnectionGroup[];
  /** 传入已有连接表示编辑模式，表单会回显该连接数据。 */
  initialConnection?: DbConnectionConfig | null;
}

export function ConnectionDialog({
  open,
  onClose,
  onSaved,
  defaultGroup = "默认",
  groups = [],
  initialConnection,
}: ConnectionDialogProps) {
  const { t } = useI18n();
  const resolvedTheme = useSettingsStore((s) => s.resolved);
  const [form, setForm] = useState<ConnectionFormData>({ ...EMPTY_FORM, group: defaultGroup });
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
        : { ...EMPTY_FORM, group: defaultGroup }
    );
    setStatus(null);
    setTesting(false);
    setSaving(false);
  }, [open, defaultGroup, initialConnection]);

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
    if (!form.name.trim()) {
      return t("database.dialog.nameRequired");
    }
    if (!isSupportedEngine(form.engine)) {
      return t("database.dialog.unsupportedEngine");
    }
    if (!form.host.trim()) {
      return t("database.dialog.hostRequired");
    }
    if (!form.group.trim()) {
      return t("database.dialog.groupRequired");
    }
    return null;
  };

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
      void refreshAndPatchConnectionSchemaCache(saved, schemaCacheReporter);
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
        description: "mysql, postgresql, sqlite, sqlserver, redis, mongodb",
      },
      { key: "host", label: t("database.dialog.host") },
      { key: "port", label: t("database.dialog.port"), type: "number" },
      { key: "database", label: t("database.dialog.database") },
      { key: "username", label: t("database.dialog.username") },
      { key: "password", label: t("database.dialog.password") },
      { key: "group", label: t("database.dialog.group") },
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
          const engine = String(raw).trim().toLowerCase();
          if (engine in ENGINE_DEFAULTS) {
            const typed = engine as DbEngine;
            next.engine = typed;
            next.port = ENGINE_DEFAULTS[typed].port;
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
              {(Object.keys(ENGINE_DEFAULTS) as DbEngine[]).map((engine) => {
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
            <input
              id="db-conn-name"
              className="input"
              placeholder={t("database.dialog.namePlaceholder")}
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
              style={{ width: "100%" }}
            />
          </FormField>

          <FormField
            label={t("database.dialog.group")}
            htmlFor="db-conn-group"
            description={t("database.dialog.groupDescription")}
          >
            <Select
              className="input"
              value={form.group}
              onChange={(v) => update("group", v)}
              style={{ width: "100%" }}
              searchable={false}
              options={groups.map((group) => ({ value: group.name, label: group.name }))}
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
                  <input
                    id="db-conn-host"
                    className="input"
                    placeholder="localhost"
                    value={form.host}
                    onChange={(e) => update("host", e.target.value)}
                    style={{ width: "100%" }}
                  />
                </FormField>
              </div>
              <div style={{ flex: 1 }}>
                <FormField
                  label={t("database.dialog.port")}
                  htmlFor="db-conn-port"
                  description={t("database.dialog.portDescription")}
                >
                  <input
                    id="db-conn-port"
                    className="input"
                    placeholder={ENGINE_DEFAULTS[form.engine].port}
                    value={form.port}
                    onChange={(e) => update("port", e.target.value)}
                    style={{ width: "100%" }}
                  />
                </FormField>
              </div>
            </div>
          )}

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
            <input
              id="db-conn-database"
              className="input"
              placeholder={
                isFileBased
                  ? "/path/to/file.db"
                  : form.engine === "redis"
                    ? "0"
                    : t("database.dialog.databasePlaceholder")
              }
              value={form.database}
              onChange={(e) => update("database", e.target.value)}
              style={{ width: "100%" }}
            />
          </FormField>

          {!isFileBased && (
            <div className="form-row">
              <div style={{ flex: 1 }}>
                <FormField
                  label={t("database.dialog.username")}
                  htmlFor="db-conn-username"
                  description={t("database.dialog.usernameDescription")}
                >
                  <input
                    id="db-conn-username"
                    className="input"
                    placeholder={form.engine === "redis" ? "default" : "postgres"}
                    value={form.username}
                    onChange={(e) => update("username", e.target.value)}
                    style={{ width: "100%" }}
                  />
                </FormField>
              </div>
              <div style={{ flex: 1 }}>
                <FormField
                  label={t("database.dialog.password")}
                  htmlFor="db-conn-password"
                  description={t("database.dialog.passwordDescription")}
                >
                  <input
                    id="db-conn-password"
                    className="input"
                    type="password"
                    placeholder="••••••"
                    value={form.password}
                    onChange={(e) => update("password", e.target.value)}
                    style={{ width: "100%" }}
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

    </FormDialog>
  );
}
