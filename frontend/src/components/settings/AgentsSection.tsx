import { useCallback, useEffect, useMemo, useState } from "react";

import { useI18n } from "../../i18n";
import { AGENT_ADAPTERS, getAgentAdapter } from "../../lib/agents/registry";
import type { AgentKind } from "../../lib/agents/types";
import { isSupportedAgentKind } from "../../lib/agents/types";
import { statusByKind } from "../../lib/agents/detect";
import { useAcpServicesStore } from "../../stores/acpServicesStore";
import {
  countEnabledCliModels,
  getCliProviderModels,
  resolveAgentOnlineStatus,
  cliProviderOnlineStatusLabelKey,
  useCliProvidersStore,
} from "../../stores/cliProvidersStore";
import { isTauriRuntime } from "../../lib/isTauriRuntime";
import { Button } from "../ui/primitives/Button";
import { StatusDot } from "../ui/primitives/StatusDot";
import { ModuleEmptyState } from "../ui/feedback/ModuleEmptyState";
import { CliProviderModelList } from "./CliProviderModelList";

/** 取 `--version` 首行；过长截断，避免多行（如 Cursor）撑破副标题。 */
function formatAgentVersion(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const first =
    raw
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? null;
  if (!first) return null;
  return first.length > 64 ? `${first.slice(0, 61)}…` : first;
}

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
  const onlineStatusById = useCliProvidersStore((s) => s.onlineStatusById);
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
    // 打开设置：同步启用态；若尚无检测缓存则补一次检测（供版本号展示）。
    // 「重新检测」按钮才会 force 重扫 PATH。
    void syncProviders();
    if (installStatuses.length === 0) {
      void refreshDetection();
    }
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
        const detail = t("settings.cliProviders.refresh.failed");
        setRefreshNotice({
          providerId,
          kind: "err",
          message: detail,
        });
      }
    },
    [refreshModels, t],
  );

  const sortedProviders = useMemo(() => {
    const order = AGENT_ADAPTERS.map((a) => a.kind);
    return [...providers]
      .filter((p) => isSupportedAgentKind(p.id))
      .sort((a, b) => {
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
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={detecting || syncing || !isTauriRuntime()}
          onClick={() => {
            void (async () => {
              await refreshDetection();
              await syncProviders({ forceModels: true });
            })();
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
            const installed =
              status !== undefined ? status.installed : Boolean(provider.binary?.trim());
            const models = getCliProviderModels(provider, modelCache);
            const hasModels = models.length > 0;
            const isExpanded = expandedIds.has(provider.id);
            const enabledCount = countEnabledCliModels(provider, models);
            const isRefreshing = Boolean(refreshingModelIds[provider.id]);
            const onlineStatus = resolveAgentOnlineStatus(
              provider.id,
              installed,
              Boolean(provider.enabled),
              onlineStatusById[provider.id],
              isRefreshing,
              models.length,
            );
            const onlineLabel = t(cliProviderOnlineStatusLabelKey(onlineStatus));
            const notice = refreshNotice?.providerId === provider.id ? refreshNotice : null;

            return (
              <li
                key={provider.id}
                className={`ai-provider-card${provider.enabled ? " ai-provider-card--active" : ""}${!installed ? " ai-provider-card--disabled" : ""}`}
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
                          if (willExpand && installed) {
                            // 静默刷新：已在线时不闪「连接中」
                            void refreshModels(provider.id, { silent: true }).catch(() => undefined);
                          }
                        }}
                      >
                        {isExpanded ? "▾" : "▸"}
                      </button>
                    ) : (
                      <span className="ai-provider-expand-placeholder" aria-hidden />
                    )}
                    <div className="ai-provider-summary">
                      <div className="ai-provider-title-row">
                        <StatusDot
                          status={onlineStatus}
                          size="sm"
                          title={onlineLabel}
                          label={onlineLabel}
                        />
                        <span className="ai-provider-name">
                          {adapter ? t(adapter.nameKey) : provider.displayName}
                        </span>
                        <span
                          className={`ai-provider-online-tag ai-provider-online-tag--${onlineStatus}`}
                        >
                          {onlineLabel}
                        </span>
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
                        <span
                          className="ai-model-row-key"
                          title={
                            installed && status?.executablePath
                              ? status.executablePath
                              : undefined
                          }
                        >
                          {!installed
                            ? t("settings.cliProviders.notFound")
                            : formatAgentVersion(status?.version) ??
                              t("settings.cliProviders.installed")}
                        </span>
                      </div>
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
