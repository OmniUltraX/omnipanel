import { useState, useEffect, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAiStore } from "../../stores/aiStore";
import { detectMonospaceFonts } from "../../lib/systemFonts";
import {
  useAiModelsStore,
  maskApiKey,
  type AiModelProvider,
} from "../../stores/aiModelsStore";
import {
  useSettingsStore,
  LOCALE_OPTIONS,
  UI_SCALE,
  ACCENT_PRESETS,
  ACCENT_ORDER,
  clampUiScale,
  type Locale,
  type ProxyProtocol,
  type AiDisplayMode,
} from "../../stores/settingsStore";
import {
  SHORTCUT_DEFS,
  useShortcutsStore,
  getShortcutKeys,
} from "../../stores/shortcutsStore";
import { SidebarWorkspace } from "../../components/ui/SidebarWorkspace";
import { ShortcutRecorder } from "../../components/settings/ShortcutRecorder";
import { AddModelDialog } from "../../components/settings/AddModelDialog";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Select";
import { useI18n } from "../../i18n";
import { commands } from "../../ipc/bindings";
import { invoke } from "@tauri-apps/api/core";
import type { UpdateInfo } from "../../ipc/bindings";

type Section = "general" | "appearance" | "keybindings" | "ai" | "security" | "terminal" | "data";

interface NavItem {
  id: Section;
  label: string;
  icon: ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  {
    id: "general",
    label: "通用",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
      </svg>
    ),
  },
  {
    id: "appearance",
    label: "外观",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="5" />
        <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
      </svg>
    ),
  },
  {
    id: "keybindings",
    label: "快捷键",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M8 16h8" />
      </svg>
    ),
  },
  {
    id: "ai",
    label: "AI 模型",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 2a4 4 0 014 4v1a4 4 0 01-8 0V6a4 4 0 014-4z" />
        <path d="M12 17v4M8 21h8" />
      </svg>
    ),
  },
  {
    id: "security",
    label: "安全",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    ),
  },
  {
    id: "terminal",
    label: "终端",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M4 17l6-6-6-6" />
        <path d="M12 19h8" />
      </svg>
    ),
  },
  {
    id: "data",
    label: "数据与备份",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
        <path d="M7 10l5 5 5-5" />
        <path d="M12 15V3" />
      </svg>
    ),
  },
];

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div
      className={`toggle ${value ? "on" : ""}`}
      onClick={() => onChange(!value)}
      style={{ cursor: "pointer" }}
    />
  );
}

function SettingSelect({
  value,
  onChange,
  options,
  optionLabels,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  optionLabels?: string[];
}) {
  const selectOptions = optionLabels
    ? options.map((v, i) => ({ value: v, label: optionLabels[i] ?? v }))
    : options;
  return (
    <Select
      className="setting-select"
      size="sm"
      value={value}
      options={selectOptions}
      onChange={onChange}
      searchable={options.length > 6}
    />
  );
}

function UiScaleControl({
  value,
  onChange,
}: {
  value: number;
  onChange: (percent: number) => void;
}) {
  const { t } = useI18n();
  const atMin = value <= UI_SCALE.min;
  const atMax = value >= UI_SCALE.max;

  const stepBy = (delta: number) => onChange(clampUiScale(value + delta));

  return (
    <div className="setting-control setting-scale">
      <div className="setting-scale__group" role="group" aria-label={t("settings.uiScale.label")}>
        <button
          type="button"
          className="setting-scale__step"
          disabled={atMin}
          onClick={() => stepBy(-UI_SCALE.step)}
          aria-label={t("settings.uiScale.decrease")}
        >
          −
        </button>
        <div className="setting-scale__field">
          <input
            type="number"
            className="setting-scale__input"
            min={UI_SCALE.min}
            max={UI_SCALE.max}
            step={UI_SCALE.step}
            value={value}
            onChange={(e) => {
              const v = e.target.valueAsNumber;
              if (Number.isFinite(v)) onChange(v);
            }}
            onBlur={(e) => {
              const v = e.target.valueAsNumber;
              if (Number.isFinite(v)) onChange(v);
              else onChange(value);
            }}
            aria-label={t("settings.uiScale.value", { percent: value })}
          />
          <span className="setting-scale__suffix" aria-hidden>
            %
          </span>
        </div>
        <button
          type="button"
          className="setting-scale__step"
          disabled={atMax}
          onClick={() => stepBy(UI_SCALE.step)}
          aria-label={t("settings.uiScale.increase")}
        >
          +
        </button>
      </div>
      {value !== UI_SCALE.default && (
        <>
          <span className="setting-scale__sep" aria-hidden />
          <button
            type="button"
            className="setting-scale__reset"
            onClick={() => onChange(UI_SCALE.default)}
          >
            {t("settings.uiScale.reset")}
          </button>
        </>
      )}
    </div>
  );
}

function KeybindingsSection() {
  const { t } = useI18n();
  const overrides = useShortcutsStore((s) => s.overrides);
  const resetAll = useShortcutsStore((s) => s.resetAll);
  const hasOverrides = Object.keys(overrides).length > 0;

  return (
    <div className="settings-panel active">
      <div className="settings-section">
        <div className="settings-section-header">
          <div>
            <h2>{t("settings.keybindings.title")}</h2>
            <p className="section-desc">{t("settings.keybindings.description")}</p>
          </div>
          {hasOverrides && (
            <Button
              variant="ghost"
              size="sm"
              onClick={resetAll}
            >
              {t("settings.keybindings.resetAll")}
            </Button>
          )}
        </div>

        {SHORTCUT_DEFS.map((def) => {
          const current = getShortcutKeys(def.id);
          const label = t(def.labelKey);
          const isCustomized = def.id in overrides;
          return (
            <div key={def.id} className="setting-row">
              <div className="setting-label">
                <h4>
                  {label}
                  {isCustomized && <span className="keybind-modified-dot" aria-hidden />}
                </h4>
              </div>
              <ShortcutRecorder
                id={def.id}
                value={current}
                disabled={def.nonRecordable}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AiModelsSection() {
  const { t } = useI18n();
  const aiDisplayMode = useSettingsStore((s) => s.aiDisplayMode);
  const setAiDisplayMode = useSettingsStore((s) => s.setAiDisplayMode);
  const providers = useAiModelsStore((s) => s.providers);
  const removeProvider = useAiModelsStore((s) => s.removeProvider);

  const [showDialog, setShowDialog] = useState(false);
  const [editingProvider, setEditingProvider] = useState<AiModelProvider | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const openAddDialog = () => {
    setEditingProvider(null);
    setShowDialog(true);
  };

  const openEditDialog = (provider: AiModelProvider) => {
    setConfirmDeleteId(null);
    setEditingProvider(provider);
    setShowDialog(true);
  };

  const closeDialog = () => {
    setShowDialog(false);
    setEditingProvider(null);
  };

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="settings-panel active">
      <div className="settings-section">
        <div className="settings-section-header">
          <div>
            <h2>{t("settings.aiModels.title")}</h2>
            <p className="section-desc">{t("settings.aiModels.description")}</p>
          </div>
          <Button
            variant="primary"
            size="sm"
            className="ai-models-add-btn"
            onClick={openAddDialog}
            title={t("settings.aiModels.add.title")}
            aria-label={t("settings.aiModels.add.title")}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              width="14"
              height="14"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span>{t("settings.aiModels.add.title")}</span>
          </Button>
        </div>

        {providers.length === 0 ? (
          <div className="ai-models-empty">
            <div className="ai-models-empty-icon">🤖</div>
            <div className="ai-models-empty-title">{t("settings.aiModels.empty.title")}</div>
            <div className="ai-models-empty-desc">{t("settings.aiModels.empty.desc")}</div>
            <Button
              variant="secondary"
              size="sm"
              style={{ marginTop: "var(--sp-3)" }}
              onClick={openAddDialog}
            >
              {t("settings.aiModels.empty.cta")}
            </Button>
          </div>
        ) : (
          <ul className="ai-models-list">
            {providers.map((provider) => {
              const isConfirmingDelete = confirmDeleteId === provider.id;
              const hasMultipleModels = provider.modelNames.length > 1;
              const isExpanded = expandedIds.has(provider.id);
              return (
                <li key={provider.id} className="ai-provider-card">
                  <div className="ai-provider-header">
                    <div className="ai-provider-header-main">
                      {hasMultipleModels ? (
                        <button
                          type="button"
                          className="ai-provider-expand"
                          aria-expanded={isExpanded}
                          aria-label={t("settings.aiModels.toggleModels")}
                          onClick={() => toggleExpanded(provider.id)}
                        >
                          {isExpanded ? "▾" : "▸"}
                        </button>
                      ) : (
                        <span className="ai-provider-expand-placeholder" aria-hidden />
                      )}
                      <div className="ai-provider-summary">
                        <div className="ai-provider-title-row">
                          <span className="ai-provider-name">{provider.providerName}</span>
                          <span
                            className={`ai-model-row-standard ai-model-row-standard-${provider.apiStandard}`}
                          >
                            {provider.apiStandard === "openai" ? "OpenAI" : "Anthropic"}
                          </span>
                          {hasMultipleModels ? (
                            <span className="ai-provider-model-count">
                              {t("settings.aiModels.modelCount", {
                                count: provider.modelNames.length,
                              })}
                            </span>
                          ) : (
                            <span className="ai-provider-single-model">{provider.modelNames[0]}</span>
                          )}
                        </div>
                        <div className="ai-model-row-meta">
                          <span className="ai-model-row-baseurl" title={provider.baseUrl}>
                            {provider.baseUrl}
                          </span>
                          <span className="ai-model-row-sep">·</span>
                          <span className="ai-model-row-key" title={provider.apiKey}>
                            {maskApiKey(provider.apiKey)}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="ai-model-row-actions">
                      {isConfirmingDelete ? (
                        <>
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => {
                              removeProvider(provider.id);
                              setConfirmDeleteId(null);
                            }}
                          >
                            {t("settings.aiModels.confirmDelete")}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setConfirmDeleteId(null)}
                          >
                            {t("settings.aiModels.cancelDelete")}
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="ai-model-row-edit"
                            title={t("settings.aiModels.editBtn")}
                            aria-label={t("settings.aiModels.editBtn")}
                            onClick={() => openEditDialog(provider)}
                          >
                            <svg
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              width="14"
                              height="14"
                            >
                              <path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
                            </svg>
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="ai-model-row-delete"
                            title={t("settings.aiModels.deleteBtn")}
                            aria-label={t("settings.aiModels.deleteBtn")}
                            onClick={() => setConfirmDeleteId(provider.id)}
                          >
                            <svg
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              width="14"
                              height="14"
                            >
                              <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                            </svg>
                          </Button>
                        </>
                      )}
                    </div>
                  </div>

                  {hasMultipleModels && isExpanded ? (
                    <ul className="ai-provider-models">
                      {provider.modelNames.map((modelName) => (
                        <li key={modelName} className="ai-provider-model-item">
                          {modelName}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <AddModelDialog
        open={showDialog}
        onClose={closeDialog}
        editProvider={editingProvider}
      />

      <div className="settings-section-divider" />

      <div className="settings-section">
        <h2>{t("settings.aiDisplay.label")}</h2>
        <p className="section-desc">{t("settings.aiDisplay.desc")}</p>
        <div className="setting-row">
          <div className="setting-label">
            <h4>{t("settings.aiDisplay.label")}</h4>
          </div>
          <Select
            className="setting-select"
            size="sm"
            value={aiDisplayMode}
            onChange={(v) => setAiDisplayMode(v as AiDisplayMode)}
            searchable={false}
            options={[
              { value: "subwindow", label: t("settings.aiDisplay.subwindow") },
              { value: "dockview", label: t("settings.aiDisplay.dockview") },
            ]}
          />
        </div>
      </div>
    </div>
  );
}

export function SettingsPanel() {
  const { t } = useI18n();
  const [activeSection, setActiveSection] = useState<Section>("general");

  const locale = useSettingsStore((s) => s.locale);
  const setLocale = useSettingsStore((s) => s.setLocale);
  const uiScale = useSettingsStore((s) => s.uiScale);
  const setUiScale = useSettingsStore((s) => s.setUiScale);
  const [launchOnStartup, setLaunchOnStartup] = useState(false);
  const [restoreSession, setRestoreSession] = useState(true);
  const [checkUpdates, setCheckUpdates] = useState(true);
  const [telemetry, setTelemetry] = useState(false);

  // Proxy settings state
  const proxy = useSettingsStore((s) => s.proxy);
  const setProxy = useSettingsStore((s) => s.setProxy);

  // Appearance settings state
  const { theme, setTheme, accentColor, setAccentColor } = useSettingsStore();
  const [uiDensity, setUiDensity] = useState("标准");
  const [sidebarPos, setSidebarPos] = useState("左侧");

  // AI settings are managed by the new AiModelsSection component.

  // Security settings state
  const [credentialStorage, setCredentialStorage] = useState("系统钥匙串");
  const [prodConfirm, setProdConfirm] = useState(true);
  const [dangerDetection, setDangerDetection] = useState(true);
  const [aiApproval, setAiApproval] = useState(true);
  const [dataSentToAi, setDataSentToAi] = useState("最小化（已脱敏）");
  const [auditLog, setAuditLog] = useState(true);
  const [sensitiveMask, setSensitiveMask] = useState(true);

  // Terminal settings from store
  const terminalFontFamily = useSettingsStore((s) => s.terminalFontFamily);
  const terminalFontSize = useSettingsStore((s) => s.terminalFontSize);
  const terminalLineHeight = useSettingsStore((s) => s.terminalLineHeight);
  const terminalCursorStyle = useSettingsStore((s) => s.terminalCursorStyle);
  const terminalCursorBlink = useSettingsStore((s) => s.terminalCursorBlink);
  const terminalScrollback = useSettingsStore((s) => s.terminalScrollback);
  const terminalGpuAccel = useSettingsStore((s) => s.terminalGpuAccel);
  const terminalCopyOnSelect = useSettingsStore((s) => s.terminalCopyOnSelect);
  const setTerminalSettings = useSettingsStore((s) => s.setTerminalSettings);

  // Detect installed monospace fonts on mount
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  useEffect(() => {
    detectMonospaceFonts().then(setSystemFonts);
  }, []);

  // Update state
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [downloadPercent, setDownloadPercent] = useState<number | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const checkUpdateFn = async () => {
    setChecking(true);
    setUpdateError(null);
    try {
      const result = await commands.checkUpdate();
      if (result.status === "ok") {
        setUpdateInfo(result.data);
      } else {
        setUpdateError(result.error ?? t("settings.update.error"));
      }
    } catch {
      setUpdateError(t("settings.update.error"));
    } finally {
      setChecking(false);
    }
  };

  const installUpdateFn = async () => {
    if (!updateInfo?.available) return;
    const confirmed = window.confirm(
      t("settings.update.confirmInstall", { version: updateInfo.version })
    );
    if (!confirmed) return;

    setUpdating(true);
    setDownloadPercent(0);
    setUpdateError(null);
    let downloaded = 0;
    try {
      const unlisten = await listen<{ chunk_length: number; content_length: number | null }>(
        "update-download-progress",
        (event) => {
          downloaded += event.payload.chunk_length;
          const total = event.payload.content_length;
          if (total && total > 0) {
            setDownloadPercent(Math.round((downloaded / total) * 100));
          }
        },
      );
      const result = await commands.installUpdate();
      unlisten();
      if (result.status === "error") {
        setUpdateError(result.error ?? t("settings.update.installError"));
      }
    } catch {
      setUpdateError(t("settings.update.installError"));
    } finally {
      setUpdating(false);
      setDownloadPercent(null);
    }
  };

  useEffect(() => {
    if (checkUpdates) {
      checkUpdateFn();
    }
  }, []);

  // Sync proxy config to backend on change
  useEffect(() => {
    invoke("set_proxy_config", { config: proxy }).catch((e) => {
      console.warn("Failed to sync proxy config to backend:", e);
    });
  }, [proxy]);

  return (
    <SidebarWorkspace
      preset="settings"
      className="settings-workspace"
      sidebar={
        <div className="settings-nav">
          {NAV_ITEMS.map((item) => (
            <div
              key={item.id}
              className={`settings-nav-item ${activeSection === item.id ? "active" : ""}`}
              onClick={() => setActiveSection(item.id)}
            >
              {item.icon}
              {item.label}
            </div>
          ))}
        </div>
      }
    >
      <div className="settings-main">
        {/* General */}
        {activeSection === "general" && (
          <div className="settings-panel active">
            <div className="settings-section">
              <h2>通用</h2>
              <p className="section-desc">应用行为、启动和会话恢复设置</p>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>{t("settings.language.label")}</h4>
                  <p>{t("settings.language.desc")}</p>
                </div>
                <Select
                  className="setting-select"
                  size="sm"
                  value={locale}
                  onChange={(v) => setLocale(v as Locale)}
                  searchable={false}
                  options={LOCALE_OPTIONS.map((opt) => ({
                    value: opt.value,
                    label: t(opt.labelKey),
                  }))}
                />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>{t("settings.uiScale.label")}</h4>
                  <p>{t("settings.uiScale.desc")}</p>
                </div>
                <UiScaleControl value={uiScale} onChange={setUiScale} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>开机启动</h4>
                  <p>系统启动后自动打开 OmniPanel</p>
                </div>
                <Toggle value={launchOnStartup} onChange={setLaunchOnStartup} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>恢复上次会话</h4>
                  <p>重新打开上次的标签、布局和连接</p>
                </div>
                <Toggle value={restoreSession} onChange={setRestoreSession} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>{t("settings.update.checkLabel")}</h4>
                  <p>{t("settings.update.checkDesc")}</p>
                </div>
                <Toggle value={checkUpdates} onChange={setCheckUpdates} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>{t("settings.update.updateLabel")}</h4>
                  <p>
                    {t("settings.update.currentVersion", {
                      version: updateInfo?.current_version ?? "0.1.0",
                    })}
                    {updateInfo?.available && (
                      <span style={{ color: "var(--accent)", marginLeft: "var(--sp-2)" }}>
                        {t("settings.update.newVersion", { version: updateInfo.version })}
                      </span>
                    )}
                    {updateInfo && !updateInfo.available && !checking && (
                      <span style={{ color: "var(--success)", marginLeft: "var(--sp-2)" }}>
                        {t("settings.update.upToDate")}
                      </span>
                    )}
                  </p>
                  {updateInfo?.body && (
                    <details className="update-changelog" style={{ marginTop: "var(--sp-1)" }}>
                      <summary>{t("settings.update.releaseNotes")}</summary>
                      <pre
                        className="update-changelog-body"
                        style={{ fontSize: 11, maxHeight: 160, overflow: "auto", whiteSpace: "pre-wrap" }}
                      >
                        {updateInfo.body}
                      </pre>
                    </details>
                  )}
                  {updateError && (
                    <p style={{ color: "var(--danger)", marginTop: "var(--sp-1)" }}>{updateError}</p>
                  )}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)", alignItems: "flex-end" }}>
                  <div style={{ display: "flex", gap: "var(--sp-2)" }}>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={checkUpdateFn}
                      disabled={checking || updating}
                    >
                      {checking ? t("settings.update.checking") : t("settings.update.checkBtn")}
                    </Button>
                    {updateInfo?.available && !updating && (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={installUpdateFn}
                      >
                        {t("settings.update.installBtn")}
                      </Button>
                    )}
                  </div>
                  {updating && downloadPercent != null && (
                    <div className="update-progress-bar">
                      <div className="update-progress-fill" style={{ width: `${downloadPercent}%` }} />
                    </div>
                  )}
                  {updating && (
                    <span style={{ fontSize: 11, color: "var(--meta)" }}>
                      {t("settings.update.installing")}
                    </span>
                  )}
                </div>
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>遥测</h4>
                  <p>发送匿名使用数据，不收集个人信息</p>
                </div>
                <Toggle value={telemetry} onChange={setTelemetry} />
              </div>

              {/* Proxy */}
              <div className="settings-section-divider" />
              <div className="setting-row">
                <div className="setting-label">
                  <h4>{t("settings.proxy.label")}</h4>
                  <p>{t("settings.proxy.desc")}</p>
                </div>
                <Toggle value={proxy.enabled} onChange={(v) => setProxy({ ...proxy, enabled: v })} />
              </div>
              {proxy.enabled && (
                <>
                  <div className="setting-row">
                    <div className="setting-label">
                      <h4>{t("settings.proxy.protocol")}</h4>
                    </div>
                    <Select
                      className="setting-select"
                      size="sm"
                      value={proxy.protocol}
                      onChange={(v) => setProxy({ ...proxy, protocol: v as ProxyProtocol })}
                      searchable={false}
                      options={[
                        { value: "http", label: "HTTP" },
                        { value: "https", label: "HTTPS" },
                        { value: "socks5", label: "SOCKS5" },
                      ]}
                    />
                  </div>
                  <div className="setting-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--sp-3)" }}>
                    <div>
                      <div className="setting-label">
                        <h4>{t("settings.proxy.host")}</h4>
                      </div>
                      <input
                        className="setting-input"
                        type="text"
                        placeholder={t("settings.proxy.hostPlaceholder")}
                        value={proxy.host}
                        onChange={(e) => setProxy({ ...proxy, host: e.target.value })}
                      />
                    </div>
                    <div>
                      <div className="setting-label">
                        <h4>{t("settings.proxy.port")}</h4>
                      </div>
                      <input
                        className="setting-input"
                        type="number"
                        min={1}
                        max={65535}
                        value={proxy.port}
                        onChange={(e) => setProxy({ ...proxy, port: parseInt(e.target.value, 10) || 0 })}
                      />
                    </div>
                  </div>
                  <div className="setting-row">
                    <div className="setting-label">
                      <h4>{t("settings.proxy.auth")}</h4>
                    </div>
                  </div>
                  <div className="setting-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--sp-3)" }}>
                    <div>
                      <div className="setting-label">
                        <h4>{t("settings.proxy.username")}</h4>
                      </div>
                      <input
                        className="setting-input"
                        type="text"
                        placeholder={t("settings.proxy.usernamePlaceholder")}
                        value={proxy.username}
                        onChange={(e) => setProxy({ ...proxy, username: e.target.value })}
                      />
                    </div>
                    <div>
                      <div className="setting-label">
                        <h4>{t("settings.proxy.password")}</h4>
                      </div>
                      <input
                        className="setting-input"
                        type="password"
                        placeholder={t("settings.proxy.passwordPlaceholder")}
                        value={proxy.password}
                        onChange={(e) => setProxy({ ...proxy, password: e.target.value })}
                      />
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Appearance */}
        {activeSection === "appearance" && (
          <div className="settings-panel active">
            <div className="settings-section">
              <h2>外观</h2>
              <p className="section-desc">主题、字体和界面密度设置</p>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>主题</h4>
                  <p>应用配色方案</p>
                </div>
                <Select
                  className="setting-select"
                  size="sm"
                  value={theme}
                  onChange={(v) => setTheme(v as "system" | "light" | "dark")}
                  searchable={false}
                  options={[
                    { value: "system", label: "跟随系统" },
                    { value: "light", label: "浅色" },
                    { value: "dark", label: "深色" },
                  ]}
                />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>强调色</h4>
                  <p>用于高亮和主要操作的颜色</p>
                </div>
                <div className="accent-picker">
                  {ACCENT_ORDER.map((id) => {
                    const palette = ACCENT_PRESETS[id];
                    const selected = accentColor === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        className={`accent-swatch${selected ? " selected" : ""}`}
                        style={{ background: palette.swatch }}
                        title={t(`settings.appearance.accent.${id}`)}
                        aria-label={t(`settings.appearance.accent.${id}`)}
                        aria-pressed={selected}
                        onClick={() => setAccentColor(id)}
                      />
                    );
                  })}
                </div>
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>界面密度</h4>
                  <p>控制间距和元素尺寸</p>
                </div>
                <SettingSelect value={uiDensity} onChange={setUiDensity} options={["紧凑", "标准", "舒适"]} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>侧栏位置</h4>
                  <p>显示在窗口左侧或右侧</p>
                </div>
                <SettingSelect value={sidebarPos} onChange={setSidebarPos} options={["左侧", "右侧"]} />
              </div>
            </div>
          </div>
        )}

        {/* Keybindings */}
        {activeSection === "keybindings" && <KeybindingsSection />}

        {/* AI Models */}
        {activeSection === "ai" && <AiModelsSection />}

        {/* Security */}
        {activeSection === "security" && (
          <div className="settings-panel active">
            <div className="settings-section">
              <h2>安全</h2>
              <p className="section-desc">凭据存储、AI 安全和操作策略</p>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>凭据存储</h4>
                  <p>SSH Key、数据库密码和 API Key 的存储位置</p>
                </div>
                <SettingSelect value={credentialStorage} onChange={setCredentialStorage} options={["系统钥匙串", "加密 SQLite"]} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>生产环境确认</h4>
                  <p>在生产服务器执行操作前必须确认</p>
                </div>
                <Toggle value={prodConfirm} onChange={setProdConfirm} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>危险命令检测</h4>
                  <p>执行 rm -rf、DROP TABLE、docker rm 等操作前发出警告</p>
                </div>
                <Toggle value={dangerDetection} onChange={setDangerDetection} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>AI 操作审批</h4>
                  <p>AI 执行任何写操作前必须由用户确认</p>
                </div>
                <Toggle value={aiApproval} onChange={setAiApproval} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>发送给 AI 的数据</h4>
                  <p>发送给 AI 提供商时包含哪些上下文</p>
                </div>
                <SettingSelect value={dataSentToAi} onChange={setDataSentToAi} options={["最小化（已脱敏）", "完整上下文", "不发送"]} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>审计日志</h4>
                  <p>记录所有高风险操作、AI 动作和数据修改</p>
                </div>
                <Toggle value={auditLog} onChange={setAuditLog} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>敏感数据脱敏</h4>
                  <p>自动隐藏邮箱、手机号、Token 和密码</p>
                </div>
                <Toggle value={sensitiveMask} onChange={setSensitiveMask} />
              </div>
            </div>
          </div>
        )}

        {/* Terminal */}
        {activeSection === "terminal" && (
          <div className="settings-panel active">
            <div className="settings-section">
              <h2>{t("settings.terminal.label")}</h2>
              <p className="section-desc">{t("settings.terminal.desc")}</p>

              {/* Live preview */}
              <div className="terminal-preview">
                <div className="terminal-preview-bar">
                  <span className="terminal-preview-dot" />
                  <span className="terminal-preview-dot" />
                  <span className="terminal-preview-dot" />
                  <span className="terminal-preview-title">{t("settings.terminal.preview")}</span>
                </div>
                <div
                  className="terminal-preview-body"
                  style={{
                    fontFamily: `"${terminalFontFamily}", "Cascadia Code", "Fira Code", Menlo, Consolas, monospace`,
                    fontSize: `${terminalFontSize}px`,
                    lineHeight: terminalLineHeight,
                  }}
                >
                  <div>
                    <span style={{ color: "#4ec9b0" }}>user@omnipanel</span>
                    <span style={{ color: "#6a9955" }}>:</span>
                    <span style={{ color: "#569cd6" }}>~/project</span>
                    <span style={{ color: "#d4d4d4" }}>$ </span>
                    <span style={{ color: "#d4d4d4" }}>git status</span>
                    {terminalCursorStyle === "block" && <span className="term-cursor term-cursor--block"> </span>}
                    {terminalCursorStyle === "bar" && <span className="term-cursor term-cursor--bar" />}
                    {terminalCursorStyle === "underline" && <span className="term-cursor term-cursor--underline" />}
                  </div>
                  <div style={{ color: "#569cd6" }}>On branch main</div>
                  <div style={{ color: "#6a9955" }}>Changes committed:</div>
                  <div>
                    <span style={{ color: "#d4d4d4" }}>  modified: </span>
                    <span style={{ color: "#ce9178" }}>src/App.tsx</span>
                  </div>
                  <div>
                    <span style={{ color: "#d4d4d4" }}>  new file: </span>
                    <span style={{ color: "#ce9178" }}>src/modules/ai/AgentPanel.tsx</span>
                  </div>
                  <div style={{ color: "#d4d4d4" }}>$ <span className="term-cursor-blink" style={{
                    display: "inline-block",
                    width: terminalCursorStyle === "block" ? `${terminalFontSize * 0.6}px` : terminalCursorStyle === "underline" ? `${terminalFontSize * 0.6}px` : "2px",
                    height: terminalCursorStyle === "block" ? `${terminalFontSize}px` : terminalCursorStyle === "underline" ? "2px" : `${terminalFontSize}px`,
                    background: "#d4d4d4",
                    verticalAlign: terminalCursorStyle === "underline" ? "bottom" : "text-bottom",
                    animation: terminalCursorBlink ? "term-blink 1s step-end infinite" : "none",
                  }} /></div>
                </div>
              </div>

              <div className="setting-row">
                <div className="setting-label">
                  <h4>{t("settings.terminal.fontFamily")}</h4>
                  <p>{t("settings.terminal.fontFamilyDesc")}</p>
                </div>
                <SettingSelect
                  value={terminalFontFamily}
                  onChange={(v) => setTerminalSettings({ terminalFontFamily: v })}
                  options={
                    systemFonts.length > 0
                      ? systemFonts.includes(terminalFontFamily)
                        ? systemFonts
                        : [terminalFontFamily, ...systemFonts]
                      : [terminalFontFamily, "Cascadia Code", "JetBrains Mono", "Fira Code", "IBM Plex Mono", "Consolas", "Menlo"]
                  }
                />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>{t("settings.terminal.fontSize")}</h4>
                </div>
                <SettingSelect value={String(terminalFontSize)} onChange={(v) => setTerminalSettings({ terminalFontSize: Number(v) })} options={["11", "12", "13", "14", "15", "16", "18"]} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>{t("settings.terminal.lineHeight")}</h4>
                </div>
                <SettingSelect value={String(terminalLineHeight)} onChange={(v) => setTerminalSettings({ terminalLineHeight: Number(v) })} options={["1.2", "1.4", "1.6", "1.8"]} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>{t("settings.terminal.cursorStyle")}</h4>
                </div>
                <SettingSelect value={terminalCursorStyle} onChange={(v) => setTerminalSettings({ terminalCursorStyle: v as "block" | "bar" | "underline" })} options={["block", "bar", "underline"]} optionLabels={[t("settings.terminal.cursorBlock"), t("settings.terminal.cursorBar"), t("settings.terminal.cursorUnderline")]} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>{t("settings.terminal.cursorBlink")}</h4>
                </div>
                <Toggle value={terminalCursorBlink} onChange={(v) => setTerminalSettings({ terminalCursorBlink: v })} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>{t("settings.terminal.scrollback")}</h4>
                  <p>{t("settings.terminal.scrollbackDesc")}</p>
                </div>
                <SettingSelect value={String(terminalScrollback)} onChange={(v) => setTerminalSettings({ terminalScrollback: Number(v) })} options={["1000", "5000", "10000", "50000"]} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>{t("settings.terminal.gpuAccel")}</h4>
                  <p>{t("settings.terminal.gpuAccelDesc")}</p>
                </div>
                <Toggle value={terminalGpuAccel} onChange={(v) => setTerminalSettings({ terminalGpuAccel: v })} />
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>{t("settings.terminal.copyOnSelect")}</h4>
                  <p>{t("settings.terminal.copyOnSelectDesc")}</p>
                </div>
                <Toggle value={terminalCopyOnSelect} onChange={(v) => setTerminalSettings({ terminalCopyOnSelect: v })} />
              </div>
            </div>
          </div>
        )}

        {/* Data & Backup */}
        {activeSection === "data" && (
          <div className="settings-panel active">
            <div className="settings-section">
              <h2>Data &amp; Backup</h2>
              <p className="section-desc">Local data management, import/export, and cleanup</p>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Export all data</h4>
                  <p>Export connections, settings, history, and workflows to a file</p>
                </div>
                <Button variant="secondary" size="sm">Export</Button>
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Import data</h4>
                  <p>Import from OmniPanel export, Xshell, WindTerm, or OpenSSH config</p>
                </div>
                <Button variant="secondary" size="sm">Import</Button>
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Clear command history</h4>
                  <p>Remove all saved terminal command history</p>
                </div>
                <Button variant="danger" size="sm">Clear</Button>
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Clear AI conversation history</h4>
                  <p>Remove all saved AI chat history</p>
                </div>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => {
                    useAiStore.setState({ conversations: [], activeConversationId: null });
                  }}
                >
                  Clear
                </Button>
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Clear SQL history</h4>
                  <p>Remove all saved SQL query history</p>
                </div>
                <Button variant="danger" size="sm">Clear</Button>
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <h4>Reset all settings</h4>
                  <p>Restore all settings to factory defaults</p>
                </div>
                <Button variant="danger" size="sm">Reset</Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </SidebarWorkspace>
  );
}
