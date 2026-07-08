import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { useSettingsStore } from "../../stores/settingsStore";
import { useWebSearchStore } from "../../stores/webSearchStore";

const BACKEND_OPTIONS = [
  { value: "auto", labelKey: "settings.webSearch.backendAuto" },
  { value: "exa", labelKey: "settings.webSearch.backendExa" },
  { value: "ddg", labelKey: "settings.webSearch.backendDdg" },
  { value: "jina", labelKey: "settings.webSearch.backendJina" },
] as const;

export function WebSearchSettingsSection() {
  const { t } = useI18n();
  const proxy = useSettingsStore((s) => s.proxy);
  const config = useWebSearchStore((s) => s.config);
  const exaKeyConfigured = useWebSearchStore((s) => s.exaKeyConfigured);
  const lastTest = useWebSearchStore((s) => s.lastTest);
  const hydrate = useWebSearchStore((s) => s.hydrate);
  const setConfig = useWebSearchStore((s) => s.setConfig);
  const setExaKey = useWebSearchStore((s) => s.setExaKey);
  const testBackend = useWebSearchStore((s) => s.testBackend);
  const [exaKeyInput, setExaKeyInput] = useState("");
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const handleEnabledToggle = useCallback(async () => {
    if (!config) return;
    await setConfig({ ...config, enabled: !config.enabled });
  }, [config, setConfig]);

  const handleBackendChange = useCallback(
    async (backend: string) => {
      if (!config) return;
      await setConfig({ ...config, backend });
    },
    [config, setConfig],
  );

  const handleSaveExaKey = useCallback(async () => {
    await setExaKey(exaKeyInput);
    setExaKeyInput("");
  }, [exaKeyInput, setExaKey]);

  const handleTest = useCallback(async () => {
    if (!config) return;
    setTesting(true);
    try {
      await testBackend(config.backend);
    } finally {
      setTesting(false);
    }
  }, [config, testBackend]);

  if (!config) {
    return <p className="setting-hint">{t("settings.webSearch.loading")}</p>;
  }

  return (
    <div className="settings-subsection-card" style={{ marginTop: 12 }}>
      <div className="settings-subsection-title">{t("settings.webSearch.title")}</div>
      <p className="setting-hint settings-subsection-desc">{t("settings.webSearch.desc")}</p>

      <div className="setting-row">
        <div className="setting-label">
          <h4>{t("settings.webSearch.enabled")}</h4>
          <p>{t("settings.webSearch.enabledDesc")}</p>
        </div>
        <div
          className={`toggle ${config.enabled ? "on" : ""}`}
          role="switch"
          aria-checked={config.enabled}
          onClick={() => void handleEnabledToggle()}
          style={{ cursor: "pointer" }}
        />
      </div>

      <div className="setting-row">
        <div className="setting-label">
          <h4>{t("settings.webSearch.backend")}</h4>
        </div>
        <select
          className="setting-select"
          value={config.backend}
          onChange={(e) => void handleBackendChange(e.target.value)}
        >
          {BACKEND_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {t(opt.labelKey)}
            </option>
          ))}
        </select>
      </div>

      <div className="setting-row">
        <div className="setting-label">
          <h4>{t("settings.webSearch.exaKey")}</h4>
          <p>
            {exaKeyConfigured
              ? t("settings.webSearch.exaKeyConfigured")
              : t("settings.webSearch.exaKeyHint")}
          </p>
        </div>
        <div className="setting-inline-controls">
          <input
            type="password"
            className="setting-input"
            placeholder={t("settings.webSearch.exaKeyPlaceholder")}
            value={exaKeyInput}
            onChange={(e) => setExaKeyInput(e.target.value)}
          />
          <button type="button" className="btn btn-secondary" onClick={() => void handleSaveExaKey()}>
            {t("settings.webSearch.saveExaKey")}
          </button>
        </div>
      </div>

      <div className="setting-row">
        <div className="setting-label">
          <h4>{t("settings.webSearch.proxy")}</h4>
          <p>
            {proxy.enabled
              ? t("settings.webSearch.proxyEnabled", {
                  protocol: proxy.protocol,
                  host: proxy.host,
                  port: String(proxy.port),
                })
              : t("settings.webSearch.proxyDisabled")}
          </p>
        </div>
      </div>

      <div className="setting-row">
        <button type="button" className="btn btn-secondary" disabled={testing} onClick={() => void handleTest()}>
          {testing ? t("settings.webSearch.testing") : t("settings.webSearch.testBackend")}
        </button>
        {lastTest ? (
          <p className={`setting-hint${lastTest.ok ? "" : " setting-hint--warn"}`}>
            {lastTest.backend}: {lastTest.message}
          </p>
        ) : null}
      </div>
    </div>
  );
}
