import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { Modal } from "../../components/ui/Modal";
import type { DbConnectionGroup } from "../../stores/dbGroupStore";
import {
  type ConnectionFormData,
  formToConnection,
  isSupportedEngine,
  saveConnection,
  testConnection,
} from "./api";

type DbEngine = ConnectionFormData["engine"];

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
}

export function ConnectionDialog({
  open,
  onClose,
  onSaved,
  defaultGroup = "默认",
  groups = [],
}: ConnectionDialogProps) {
  const { t } = useI18n();
  const [form, setForm] = useState<ConnectionFormData>({ ...EMPTY_FORM, group: defaultGroup });
  const [status, setStatus] = useState<{ kind: "info" | "success" | "error"; message: string } | null>(
    null
  );
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setForm({ ...EMPTY_FORM, group: defaultGroup });
    setStatus(null);
    setTesting(false);
    setSaving(false);
  }, [open, defaultGroup]);

  if (!open) return null;

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
      await saveConnection(formToConnection(form));
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

  return (
    <Modal open={open} onClose={onClose}>
      <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{t("database.dialog.title")}</h3>
          <button className="btn-icon" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="modal-body">
          <div className="form-field">
            <label className="form-label">{t("database.dialog.engine")}</label>
            <div className="engine-grid">
              {(Object.keys(ENGINE_DEFAULTS) as DbEngine[]).map((engine) => (
                <button
                  key={engine}
                  className={`engine-chip${form.engine === engine ? " engine-chip--active" : ""}`}
                  onClick={() => handleEngineChange(engine)}
                >
                  <span className="engine-chip-icon">{ENGINE_DEFAULTS[engine].icon}</span>
                  <span className="engine-chip-label">{engine}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="form-field">
            <label className="form-label">{t("database.dialog.name")}</label>
            <input
              className="input"
              placeholder={t("database.dialog.namePlaceholder")}
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
              style={{ width: "100%" }}
            />
          </div>

          <div className="form-field">
            <label className="form-label">{t("database.dialog.group")}</label>
            <select
              className="input"
              value={form.group}
              onChange={(e) => update("group", e.target.value)}
              style={{ width: "100%" }}
            >
              {groups.map((group) => (
                <option key={group.id} value={group.name}>
                  {group.name}
                </option>
              ))}
            </select>
          </div>

          {!isFileBased && (
            <div className="form-row">
              <div className="form-field" style={{ flex: 2 }}>
                <label className="form-label">{t("database.dialog.host")}</label>
                <input
                  className="input"
                  placeholder="localhost"
                  value={form.host}
                  onChange={(e) => update("host", e.target.value)}
                  style={{ width: "100%" }}
                />
              </div>
              <div className="form-field" style={{ flex: 1 }}>
                <label className="form-label">{t("database.dialog.port")}</label>
                <input
                  className="input"
                  placeholder={ENGINE_DEFAULTS[form.engine].port}
                  value={form.port}
                  onChange={(e) => update("port", e.target.value)}
                  style={{ width: "100%" }}
                />
              </div>
            </div>
          )}

          <div className="form-field">
            <label className="form-label">
              {t("database.dialog.database")}
              {!isFileBased && (
                <span style={{ marginLeft: 6, fontWeight: 400, opacity: 0.6 }}>
                  ({t("database.dialog.optional")})
                </span>
              )}
            </label>
            <input
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
          </div>

          {!isFileBased && form.engine !== "redis" && (
            <div className="form-row">
              <div className="form-field" style={{ flex: 1 }}>
                <label className="form-label">{t("database.dialog.username")}</label>
                <input
                  className="input"
                  placeholder="postgres"
                  value={form.username}
                  onChange={(e) => update("username", e.target.value)}
                  style={{ width: "100%" }}
                />
              </div>
              <div className="form-field" style={{ flex: 1 }}>
                <label className="form-label">{t("database.dialog.password")}</label>
                <input
                  className="input"
                  type="password"
                  placeholder="••••••"
                  value={form.password}
                  onChange={(e) => update("password", e.target.value)}
                  style={{ width: "100%" }}
                />
              </div>
            </div>
          )}

          {!isFileBased && (
            <div className="form-field">
              <label className="form-check">
                <input
                  type="checkbox"
                  checked={form.ssl}
                  onChange={(e) => update("ssl", e.target.checked)}
                />
                <span>{t("database.dialog.ssl")}</span>
              </label>
            </div>
          )}

        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={busy}>
            {t("database.dialog.cancel")}
          </button>
          {status ? (
            <span
              className={`modal-footer-status modal-footer-status--${status.kind}`}
              title={status.message}
            >
              {status.message}
            </span>
          ) : (
            <div className="modal-footer-spacer" />
          )}
          <button className="btn btn-ghost" onClick={() => void handleTest()} disabled={busy}>
            {testing ? t("database.dialog.testing") : t("database.dialog.test")}
          </button>
          <button className="btn btn-primary" onClick={() => void handleSave()} disabled={busy}>
            {saving ? t("database.dialog.saving") : t("database.dialog.save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
