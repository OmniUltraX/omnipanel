import { useState } from "react";
import { commands } from "../../ipc/bindings";
import { useI18n } from "../../i18n";

type DbEngine = "postgresql" | "mysql" | "sqlite" | "sqlserver" | "redis" | "mongodb";

interface FormData {
  engine: DbEngine;
  name: string;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
}

const ENGINE_DEFAULTS: Record<DbEngine, { port: string; icon: string }> = {
  postgresql: { port: "5432", icon: "PG" },
  mysql: { port: "3306", icon: "MY" },
  sqlite: { port: "", icon: "SL" },
  sqlserver: { port: "1433", icon: "MS" },
  redis: { port: "6379", icon: "RE" },
  mongodb: { port: "27017", icon: "MG" },
};

interface ConnectionDialogProps {
  open: boolean;
  onClose: () => void;
  onSave?: (data: FormData) => void;
}

export function ConnectionDialog({ open, onClose, onSave }: ConnectionDialogProps) {
  const { t } = useI18n();
  const [form, setForm] = useState<FormData>({
    engine: "postgresql",
    name: "",
    host: "localhost",
    port: "5432",
    database: "",
    username: "",
    password: "",
    ssl: false,
  });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  if (!open) return null;

  const update = <K extends keyof FormData>(key: K, value: FormData[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleEngineChange = (engine: DbEngine) => {
    setForm((prev) => ({
      ...prev,
      engine,
      port: ENGINE_DEFAULTS[engine].port,
    }));
  };

  const handleSave = () => {
    onSave?.(form);
    onClose();
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await commands.dbTestConnection({
        id: "",
        name: form.name,
        db_type: form.engine,
        host: form.host,
        port: Number(form.port) || 0,
        user: form.username,
        password: form.password,
        database: form.database,
        group: "",
        status: "",
      });
      if (res.status === "ok") {
        setTestResult({ ok: true, msg: res.data });
      } else {
        setTestResult({ ok: false, msg: res.error });
      }
    } catch (e) {
      setTestResult({ ok: false, msg: String(e) });
    } finally {
      setTesting(false);
    }
  };

  const isFileBased = form.engine === "sqlite";

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="modal-header">
          <h3>{t("database.dialog.title")}</h3>
          <button className="btn-icon" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="modal-body">
          {/* Engine selector */}
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

          {/* Connection name */}
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

          {/* Host + Port (not for SQLite) */}
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

          {/* Database */}
          <div className="form-field">
            <label className="form-label">{t("database.dialog.database")}</label>
            <input
              className="input"
              placeholder={isFileBased ? "/path/to/file.db" : form.engine === "redis" ? "0" : "my_database"}
              value={form.database}
              onChange={(e) => update("database", e.target.value)}
              style={{ width: "100%" }}
            />
          </div>

          {/* Username + Password (not for SQLite/Redis) */}
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

          {/* SSL toggle (not for SQLite) */}
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

        {testResult && (
          <div
            className={`form-field ${testResult.ok ? "text-success" : "text-danger"}`}
            style={{ padding: "0 var(--sp-4)", fontSize: 12, wordBreak: "break-all" }}
          >
            {testResult.ok ? `连接成功：${testResult.msg}` : `连接失败：${testResult.msg}`}
          </div>
        )}

        {/* Footer */}
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>
            {t("database.dialog.cancel")}
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={handleTest} disabled={testing}>
            {testing ? t("database.dialog.testing") : t("database.dialog.test")}
          </button>
          <button className="btn btn-primary" onClick={handleSave}>
            {t("database.dialog.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
