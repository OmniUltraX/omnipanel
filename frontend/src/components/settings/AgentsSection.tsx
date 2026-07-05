import { useCallback, useEffect, useMemo, useState } from "react";

import { useI18n } from "../../i18n";
import { AGENT_ADAPTERS, getAgentAdapter } from "../../lib/agents/registry";
import type { AgentKind } from "../../lib/agents/types";
import { formatLaunchCommand } from "../../lib/agents/types";
import { statusByKind } from "../../lib/agents/detect";
import { useAcpServicesStore } from "../../stores/acpServicesStore";
import {
  countEnabledCliModels,
  getCliProviderModels,
  useCliProvidersStore,
} from "../../stores/cliProvidersStore";
import { isTauriRuntime } from "../../lib/isTauriRuntime";
import { Button } from "../ui/primitives/Button";
import { ModuleEmptyState } from "../ui/feedback/ModuleEmptyState";
import { CliProviderModelList } from "./CliProviderModelList";

function SettingToggle({
  value,
  onChange,
  disabled,
  label,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      className={`toggle${value ? " on" : ""}${disabled ? " toggle--disabled" : ""}`}
      role="switch"
      aria-checked={value}
      aria-disabled={disabled}
      aria-label={label}
      onClick={() => !disabled && onChange(!value)}
      style={{ cursor: disabled ? "not-allowed" : "pointer" }}
    />
  );
}

function protocolBadgeClass(protocol: string): string {
  const key = protocol.toLowerCase();
  if (key === "acp") return "openai";
  return "anthropic";
}

export function AgentsSection() {
  const { t } = useI18n();
  const installStatuses = useAcpServicesStore((s) => s.installStatuses);
  const detecting = useAcpServicesStore((s) => s.detecting);
  const refreshDetection = useAcpServicesStore((s) => s.refreshDetection);

  const providers = useCliProvidersStore((s) => s.providers);
  const modelCache = useCliProvidersStore((s) => s.modelCache);
  const loading = useCliProvidersStore((s) => s.loading);
  const syncing = useCliProvidersStore((s) => s.syncing);
  const refreshingModelIds = useCliProvidersStore((s) => s.refreshingModelIds);
  const syncProviders = useCliProvidersStore((s) => s.syncProviders);
  const refreshModels = useCliProvidersStore((s) => s.refreshModels);
  const setProviderEnabled = useCliProvidersStore((s) => s.setProviderEnabled);
  const storeError = useCliProvidersStore((s) => s.error);
  const clearError = useCliProvidersStore((s) => s.clearError);

  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [refreshNotice, setRefreshNotice] = useState<{
    providerId: string;
    kind: "ok" | "err";
    message: string;
  } | null>(null);

  useEffect(() => {
    void syncProviders();
    if (installStatuses.length === 0) {
      void refreshDetection();
    }
    // 仅在进入设置页时后台增量同步，保留 localStorage 中的上次状态
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showLoadingShell = loading && providers.length === 0;

  const enabledProviderCount = useMemo(
    () => providers.filter((p) => p.enabled).length,
    [providers],
  );

  const statusSummary = useMemo(() => {
    if (enabledProviderCount === 0) {
      return t("settings.cliProviders.noneEnabled");
    }
    return t("settings.cliProviders.enabledCount", { count: enabledProviderCount });
  }, [enabledProviderCount, t]);

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleRefreshModels = useCallback(
    async (providerId: string) => {
      setRefreshNotice(null);
      try {
        const models = await refreshModels(providerId);
        setExpandedIds((prev) => new Set(prev).add(providerId));
        setRefreshNotice({
          providerId,
          kind: "ok",
          message: t("settings.cliProviders.refresh.success", { count: models.length }),
        });
      } catch {
        setRefreshNotice({
          providerId,
          kind: "err",
          message: t("settings.cliProviders.refresh.failed"),
        });
      }
    },
    [refreshModels, t],
  );

  const sortedProviders = useMemo(() => {
    const order = AGENT_ADAPTERS.map((a) => a.kind);
    return [...providers].sort((a, b) => {
      const ai = order.indexOf(a.id as AgentKind);
      const bi = order.indexOf(b.id as AgentKind);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
  }, [providers]);

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <div>
          <h2>{t("settings.cliProviders.title")}</h2>
          <p className="section-desc">{t("settings.cliProviders.description")}</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={detecting || syncing || !isTauriRuntime()}
          onClick={() => {
            void refreshDetection();
            void syncProviders({ forceModels: true });
          }}
        >
          {detecting ? t("settings.cliProviders.detecting") : t("settings.cliProviders.redetect")}
        </Button>
      </div>

      <div className="opencode-detect-status">
        <span className="opencode-detect-status__text">{statusSummary}</span>
      </div>

      {storeError ? (
        <div className="ai-provider-refresh-notice ai-provider-refresh-notice--err">
          {storeError}
          <Button variant="ghost" size="sm" onClick={clearError} style={{ marginLeft: 8 }}>
            {t("common.cancel")}
          </Button>
        </div>
      ) : null}

      {showLoadingShell ? (
        <div className="ai-models-empty">
          <ModuleEmptyState preset="robot" title={t("settings.cliProviders.loading")} desc="" />
        </div>
      ) : (
        <ul className="ai-models-list">
          {sortedProviders.map((provider) => {
            const kind = provider.id as AgentKind;
            const adapter = AGENT_ADAPTERS.some((a) => a.kind === kind)
              ? getAgentAdapter(kind)
              : null;
            const status = statusByKind(installStatuses, kind);
            const isLegacy = kind === "omniagent";
            const installed =
              status !== undefined ? status.installed : Boolean(provider.binary?.trim());
            const models = getCliProviderModels(provider, modelCache);
            const hasModels = models.length > 0;
            const isExpanded = expandedIds.has(provider.id);
            const enabledCount = countEnabledCliModels(provider, models);
            const isRefreshing = Boolean(refreshingModelIds[provider.id]);
            const notice = refreshNotice?.providerId === provider.id ? refreshNotice : null;
            const launchCommand =
              status && adapter
                ? formatLaunchCommand(status)
                : provider.binary
                  ? [provider.binary, ...(provider.args ?? [])].filter(Boolean).join(" ")
                  : null;

            return (
              <li
                key={provider.id}
                className={`ai-provider-card${provider.enabled ? " ai-provider-card--active" : ""}${isLegacy ? " ai-provider-card--legacy" : ""}${!installed ? " ai-provider-card--disabled" : ""}`}
              >
                <div className="ai-provider-header">
                  <div className="ai-provider-header-main">
                    {hasModels ? (
                      <button
                        type="button"
                        className="ai-provider-expand"
                        aria-expanded={isExpanded}
                        aria-label={t("settings.aiModels.toggleModels")}
                        onClick={() => {
                          const willExpand = !isExpanded;
                          toggleExpanded(provider.id);
                          if (willExpand && installed) void refreshModels(provider.id);
                        }}
                      >
                        {isExpanded ? "▾" : "▸"}
                      </button>
                    ) : (
                      <span className="ai-provider-expand-placeholder" aria-hidden />
                    )}
                    <div className="ai-provider-summary">
                      <div className="ai-provider-title-row">
                        <span className="ai-provider-name">
                          {adapter ? t(adapter.nameKey) : provider.displayName}
                        </span>
                        <span
                          className={`ai-model-row-standard ai-model-row-standard-${protocolBadgeClass(provider.protocol)}`}
                        >
                          {provider.protocol.toUpperCase()}
                        </span>
                        {provider.builtin ? (
                          <span className="ai-model-row-standard ai-model-row-standard-active">
                            {t("settings.mcpServices.builtinBadge")}
                          </span>
                        ) : null}
                        {hasModels ? (
                          <span className="ai-provider-model-count">
                            {t("settings.aiModels.enabledCount", {
                              enabled: enabledCount,
                              total: models.length,
                            })}
                          </span>
                        ) : (
                          <span className="ai-provider-single-model">
                            {t("settings.aiModels.noModelsYet")}
                          </span>
                        )}
                      </div>
                      <div className="ai-model-row-meta">
                        {launchCommand ? (
                          <span className="ai-model-row-baseurl" title={launchCommand}>
                            {launchCommand}
                          </span>
                        ) : (
                          <span className="ai-model-row-baseurl">{t("settings.cliProviders.notFound")}</span>
                        )}
                        <span className="ai-model-row-sep">·</span>
                        <span className="ai-model-row-key">
                          {installed
                            ? t("settings.cliProviders.installed")
                            : t("settings.cliProviders.notFound")}
                        </span>
                      </div>
                      {adapter && isLegacy ? (
                        <p className="setting-hint">{t("settings.cliProviders.legacyHint")}</p>
                      ) : null}
                    </div>
                  </div>

                  <div className="ai-model-row-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ai-model-row-refresh"
                      title={t("settings.aiModels.refresh.title")}
                      aria-label={t("settings.aiModels.refresh.title")}
                      disabled={isRefreshing || !installed}
                      onClick={() => void handleRefreshModels(provider.id)}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        width="14"
                        height="14"
                        className={isRefreshing ? "icon-spin" : undefined}
                      >
                        <path d="M23 4v6h-6M1 20v-6h6" />
                        <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
                      </svg>
                    </Button>
                    <SettingToggle
                      value={provider.enabled ?? false}
                      disabled={!installed}
                      label={t("settings.cliProviders.toggleProvider", {
                        name: adapter ? t(adapter.nameKey) : provider.displayName,
                      })}
                      onChange={(v) => void setProviderEnabled(provider.id, v)}
                    />
                  </div>
                </div>

                {notice ? (
                  <div className={`ai-provider-refresh-notice ai-provider-refresh-notice--${notice.kind}`}>
                    {notice.message}
                  </div>
                ) : null}

                {hasModels && isExpanded ? <CliProviderModelList providerId={provider.id} /> : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
