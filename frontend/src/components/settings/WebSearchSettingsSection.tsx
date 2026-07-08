import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useI18n } from "../../i18n";
import { useSettingsStore } from "../../stores/settingsStore";
import { useWebSearchStore } from "../../stores/webSearchStore";
import { Button } from "../ui/primitives/Button";
import { PasswordInput } from "../ui/form/PasswordInput";
import { TextInput } from "../ui/form/TextInput";

const SEARCH_BACKEND_OPTIONS = [
  { value: "auto", labelKey: "settings.webSearch.backendAuto" },
  { value: "zhihu", labelKey: "settings.webSearch.backendZhihu" },
  { value: "exa", labelKey: "settings.webSearch.backendExa" },
  { value: "ddg", labelKey: "settings.webSearch.backendDdg" },
  { value: "jina", labelKey: "settings.webSearch.backendJina" },
] as const;

const FETCH_BACKEND_OPTIONS = [
  { value: "auto", labelKey: "settings.webSearch.fetchBackendAuto" },
  { value: "local", labelKey: "settings.webSearch.fetchBackendLocal" },
  { value: "jina", labelKey: "settings.webSearch.fetchBackendJina" },
] as const;

const JINA_DOMAIN_OPTIONS = [
  { value: "auto", labelKey: "settings.webSearch.jinaDomainAuto" },
  { value: "cn", labelKey: "settings.webSearch.jinaDomainCn" },
  { value: "ai", labelKey: "settings.webSearch.jinaDomainAi" },
] as const;

function formatTestMessage(
  t: (key: string) => string,
  result: { backend: string; message: string; errorKind?: string | null },
): string {
  if (!result.errorKind) {
    return `${result.backend}: ${result.message}`;
  }
  const hintKey = `settings.webSearch.errorHint.${result.errorKind}`;
  const hint = t(hintKey);
  const hintSuffix = hint === hintKey ? "" : ` — ${hint}`;
  return `${result.backend}: ${result.message}${hintSuffix}`;
}

function SecretKeyRow({
  title,
  hint,
  configured,
  placeholder,
  value,
  onChange,
  saveLabel,
  onSave,
}: {
  title: string;
  hint: string;
  configured: boolean;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  saveLabel: string;
  onSave: () => void;
}) {
  return (
    <div className="setting-row">
      <div className="setting-label">
        <h4>{title}</h4>
        <p className={configured ? "web-search-secret-status" : undefined}>{hint}</p>
      </div>
      <div className="setting-control web-search-secret-control">
        <PasswordInput
          size="sm"
          className="setting-input"
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          copyable={false}
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={!value.trim()}
          onClick={onSave}
        >
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}

function TestResult({
  ok,
  children,
}: {
  ok: boolean;
  children: ReactNode;
}) {
  return <p className={`web-search-test-result${ok ? "" : " is-error"}`}>{children}</p>;
}

export function WebSearchSettingsSection() {
  const { t } = useI18n();
  const proxy = useSettingsStore((s) => s.proxy);
  const config = useWebSearchStore((s) => s.config);
  const exaKeyConfigured = useWebSearchStore((s) => s.exaKeyConfigured);
  const zhihuSecretConfigured = useWebSearchStore((s) => s.zhihuSecretConfigured);
  const jinaKeyConfigured = useWebSearchStore((s) => s.jinaKeyConfigured);
  const lastTest = useWebSearchStore((s) => s.lastTest);
  const lastFetchTest = useWebSearchStore((s) => s.lastFetchTest);
  const hydrate = useWebSearchStore((s) => s.hydrate);
  const setConfig = useWebSearchStore((s) => s.setConfig);
  const setExaKey = useWebSearchStore((s) => s.setExaKey);
  const setZhihuSecret = useWebSearchStore((s) => s.setZhihuSecret);
  const setJinaKey = useWebSearchStore((s) => s.setJinaKey);
  const testBackend = useWebSearchStore((s) => s.testBackend);
  const testFetch = useWebSearchStore((s) => s.testFetch);

  const [exaKeyInput, setExaKeyInput] = useState("");
  const [zhihuSecretInput, setZhihuSecretInput] = useState("");
  const [jinaKeyInput, setJinaKeyInput] = useState("");
  const [fetchTestUrl, setFetchTestUrl] = useState("https://example.com");
  const [testingSearch, setTestingSearch] = useState(false);
  const [testingFetch, setTestingFetch] = useState(false);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const handleEnabledToggle = useCallback(async () => {
    if (!config) return;
    await setConfig({ ...config, enabled: !config.enabled });
  }, [config, setConfig]);

  const handleSearchBackendChange = useCallback(
    async (backend: string) => {
      if (!config) return;
      await setConfig({
        ...config,
        search: { ...config.search, backend },
      });
    },
    [config, setConfig],
  );

  const handleFetchBackendChange = useCallback(
    async (backend: string) => {
      if (!config) return;
      await setConfig({
        ...config,
        fetch: { ...config.fetch, backend },
      });
    },
    [config, setConfig],
  );

  const handleJinaDomainChange = useCallback(
    async (domain: string) => {
      if (!config) return;
      await setConfig({
        ...config,
        fetch: {
          ...config.fetch,
          jina: { ...config.fetch.jina, domain },
        },
      });
    },
    [config, setConfig],
  );

  const handleJinaNoCacheToggle = useCallback(async () => {
    if (!config) return;
    await setConfig({
      ...config,
      fetch: {
        ...config.fetch,
        jina: { ...config.fetch.jina, noCache: !config.fetch.jina.noCache },
      },
    });
  }, [config, setConfig]);

  const handleSaveExaKey = useCallback(async () => {
    await setExaKey(exaKeyInput);
    setExaKeyInput("");
  }, [exaKeyInput, setExaKey]);

  const handleSaveZhihuSecret = useCallback(async () => {
    await setZhihuSecret(zhihuSecretInput);
    setZhihuSecretInput("");
  }, [zhihuSecretInput, setZhihuSecret]);

  const handleSaveJinaKey = useCallback(async () => {
    await setJinaKey(jinaKeyInput);
    setJinaKeyInput("");
  }, [jinaKeyInput, setJinaKey]);

  const handleTestSearch = useCallback(async () => {
    if (!config) return;
    setTestingSearch(true);
    try {
      await testBackend(config.search.backend);
    } finally {
      setTestingSearch(false);
    }
  }, [config, testBackend]);

  const handleTestFetch = useCallback(async () => {
    setTestingFetch(true);
    try {
      await testFetch(fetchTestUrl);
    } finally {
      setTestingFetch(false);
    }
  }, [fetchTestUrl, testFetch]);

  if (!config) {
    return <p className="setting-hint">{t("settings.webSearch.loading")}</p>;
  }

  return (
    <div className="web-search-settings">
      <div className="settings-section-divider" />
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

      <div className="settings-subsection-title">{t("settings.webSearch.searchSection")}</div>

      <div className="setting-row">
        <div className="setting-label">
          <h4>{t("settings.webSearch.backend")}</h4>
        </div>
        <select
          className="setting-select"
          value={config.search.backend}
          onChange={(e) => void handleSearchBackendChange(e.target.value)}
        >
          {SEARCH_BACKEND_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {t(opt.labelKey)}
            </option>
          ))}
        </select>
      </div>

      <SecretKeyRow
        title={t("settings.webSearch.zhihuSecret")}
        hint={
          zhihuSecretConfigured
            ? t("settings.webSearch.zhihuSecretConfigured")
            : t("settings.webSearch.zhihuSecretHint")
        }
        configured={zhihuSecretConfigured}
        placeholder={t("settings.webSearch.zhihuSecretPlaceholder")}
        value={zhihuSecretInput}
        onChange={setZhihuSecretInput}
        saveLabel={t("settings.webSearch.saveZhihuSecret")}
        onSave={() => void handleSaveZhihuSecret()}
      />

      <SecretKeyRow
        title={t("settings.webSearch.exaKey")}
        hint={
          exaKeyConfigured
            ? t("settings.webSearch.exaKeyConfigured")
            : t("settings.webSearch.exaKeyHint")
        }
        configured={exaKeyConfigured}
        placeholder={t("settings.webSearch.exaKeyPlaceholder")}
        value={exaKeyInput}
        onChange={setExaKeyInput}
        saveLabel={t("settings.webSearch.saveExaKey")}
        onSave={() => void handleSaveExaKey()}
      />

      <div className="web-search-test-block">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={testingSearch}
          onClick={() => void handleTestSearch()}
        >
          {testingSearch ? t("settings.webSearch.testing") : t("settings.webSearch.testBackend")}
        </Button>
        {lastTest ? (
          <TestResult ok={lastTest.ok}>{formatTestMessage(t, lastTest)}</TestResult>
        ) : null}
      </div>

      <div className="settings-subsection-title">{t("settings.webSearch.fetchSection")}</div>

      <div className="setting-row">
        <div className="setting-label">
          <h4>{t("settings.webSearch.fetchBackend")}</h4>
        </div>
        <select
          className="setting-select"
          value={config.fetch.backend}
          onChange={(e) => void handleFetchBackendChange(e.target.value)}
        >
          {FETCH_BACKEND_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {t(opt.labelKey)}
            </option>
          ))}
        </select>
      </div>

      <div className="setting-row">
        <div className="setting-label">
          <h4>{t("settings.webSearch.jinaDomain")}</h4>
          <p>{t("settings.webSearch.jinaDomainHint")}</p>
        </div>
        <select
          className="setting-select"
          value={config.fetch.jina.domain}
          onChange={(e) => void handleJinaDomainChange(e.target.value)}
        >
          {JINA_DOMAIN_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {t(opt.labelKey)}
            </option>
          ))}
        </select>
      </div>

      <div className="setting-row">
        <div className="setting-label">
          <h4>{t("settings.webSearch.jinaNoCache")}</h4>
          <p>{t("settings.webSearch.jinaNoCacheDesc")}</p>
        </div>
        <div
          className={`toggle ${config.fetch.jina.noCache ? "on" : ""}`}
          role="switch"
          aria-checked={config.fetch.jina.noCache}
          onClick={() => void handleJinaNoCacheToggle()}
          style={{ cursor: "pointer" }}
        />
      </div>

      <SecretKeyRow
        title={t("settings.webSearch.jinaKey")}
        hint={
          jinaKeyConfigured
            ? t("settings.webSearch.jinaKeyConfigured")
            : t("settings.webSearch.jinaKeyHint")
        }
        configured={jinaKeyConfigured}
        placeholder={t("settings.webSearch.jinaKeyPlaceholder")}
        value={jinaKeyInput}
        onChange={setJinaKeyInput}
        saveLabel={t("settings.webSearch.saveJinaKey")}
        onSave={() => void handleSaveJinaKey()}
      />

      <div className="web-search-test-block">
        <div className="web-search-test-input-row">
          <TextInput
            size="sm"
            className="setting-input"
            clearable={false}
            copyable={false}
            placeholder={t("settings.webSearch.fetchTestUrlPlaceholder")}
            value={fetchTestUrl}
            onChange={setFetchTestUrl}
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={testingFetch || !fetchTestUrl.trim()}
            onClick={() => void handleTestFetch()}
          >
            {testingFetch ? t("settings.webSearch.testing") : t("settings.webSearch.testFetch")}
          </Button>
        </div>
        {lastFetchTest ? (
          <TestResult ok={lastFetchTest.ok}>{formatTestMessage(t, lastFetchTest)}</TestResult>
        ) : null}
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
    </div>
  );
}
