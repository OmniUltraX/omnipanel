import { useEffect, useMemo, useRef, useState } from "react";

import { useI18n } from "../../i18n";
import { fuzzyMatchModelName } from "../../lib/fetchProviderModels";
import type { AgentSourceCard, AgentSourceCredits, AgentSourceModel } from "../../ipc/bindings";
import { useAgentSourcesStore } from "../../stores/agentSourcesStore";
import { TextInput } from "../ui/form/TextInput";
import { FormDialog } from "../ui/form/FormDialog";
import { WorkbenchActionButton } from "../ui/primitives/WorkbenchActionButton";

const MODEL_PAGE_SIZE = 21;
const NO_DISABLED_MODELS: string[] = [];

function catalogLabel(source: string, t: (key: string) => string): string {
  if (source === "live") return t("settings.agentSources.catalogLive");
  if (source === "saved") return t("settings.agentSources.catalogSaved");
  return t("settings.agentSources.catalogNone");
}

function formatExpiry(ms: number | null): string {
  if (ms == null || ms <= 0) return "—";
  return new Date(ms).toLocaleString();
}

function tokenPriceTitle(credits: string): string {
  const price = credits.match(/^\$(.+)\/\$(.+)$/);
  if (!price) return credits;
  return `每百万 token 输入 $${price[1]} / 输出 $${price[2]}`;
}

function formatCredit(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function ModelToggle({
  enabled,
  onChange,
  label,
  disabled,
}: {
  enabled: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`toggle${enabled ? " on" : ""}${disabled ? " toggle--disabled" : ""}`}
      role="switch"
      aria-checked={enabled}
      aria-disabled={disabled}
      aria-label={label}
      onClick={() => {
        if (!disabled) onChange(!enabled);
      }}
      style={{ cursor: disabled ? "not-allowed" : "pointer" }}
    />
  );
}

function balanceText(
  credits: AgentSourceCredits | null,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (!credits) return t("settings.agentSources.balanceUnknown");
  if (credits.error) return t("settings.agentSources.balanceFailed");
  if (credits.unlimited) return t("settings.agentSources.balanceUnlimited");
  return t("settings.agentSources.balance", { total: formatCredit(credits.total) });
}

/** 本机 AI 提供者。密钥留在宿主，这里展示账号、有效期、余额和模型消耗比例。 */
export function AiProvidersSection() {
  const { t } = useI18n();
  const sources = useAgentSourcesStore((s) => s.sources);
  const refreshingId = useAgentSourcesStore((s) => s.refreshingId);
  const load = useAgentSourcesStore((s) => s.load);
  const refresh = useAgentSourcesStore((s) => s.refresh);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    void load();
  }, [load]);

  const refreshAll = async () => {
    const ids = sources.length > 0 ? sources.map((source) => source.id) : ["workbuddy"];
    for (const id of ids) await refresh(id);
  };

  return (
    <div className="settings-panel active">
      <div className="settings-section">
        <div className="settings-section-header">
          <div>
            <h2>{t("settings.agentSources.label")}</h2>
            <p className="section-desc">{t("settings.agentSources.desc")}</p>
          </div>
          <WorkbenchActionButton disabled={refreshingId != null} onClick={() => void refreshAll()}>
            {refreshingId != null
              ? t("settings.agentSources.refreshing")
              : t("settings.agentSources.refresh")}
          </WorkbenchActionButton>
        </div>

        {sources.length === 0 ? (
          <p className="section-desc">{t("settings.agentSources.empty")}</p>
        ) : (
          <ul className="ai-models-list">
            {sources.map((source) => (
              <ProviderCard
                key={source.id}
                source={source}
                expanded={expanded[source.id] ?? false}
                refreshing={refreshingId === source.id}
                onToggle={() =>
                  setExpanded((current) => ({
                    ...current,
                    [source.id]: !current[source.id],
                  }))
                }
                onRefresh={() => void refresh(source.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ProviderCard({
  source,
  expanded,
  refreshing,
  onToggle,
  onRefresh,
}: {
  source: AgentSourceCard;
  expanded: boolean;
  refreshing: boolean;
  onToggle: () => void;
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  const hasModels = source.models.length > 0;
  const credits = source.credits;
  const [packagesOpen, setPackagesOpen] = useState(false);
  const packages = credits && !credits.error ? credits.packages : [];
  const prefs = useAgentSourcesStore((s) => s.prefs[source.id]);
  const setSourceEnabled = useAgentSourcesStore((s) => s.setSourceEnabled);
  const sourceEnabled = prefs?.enabled ?? true;
  const disabledIds = prefs?.disabledModelIds ?? NO_DISABLED_MODELS;
  const enabledCount = source.models.filter((model) => !disabledIds.includes(model.id)).length;

  return (
    <li className={`ai-provider-card${source.signedIn && sourceEnabled ? " ai-provider-card--active" : ""}`}>
      <div className="ai-provider-header">
        <div className="ai-provider-header-main">
          {hasModels ? (
            <button
              type="button"
              className="ai-provider-expand"
              aria-expanded={expanded}
              aria-label={t("settings.aiModels.toggleModels")}
              onClick={onToggle}
            >
              {expanded ? "▾" : "▸"}
            </button>
          ) : (
            <span className="ai-provider-expand-placeholder" aria-hidden />
          )}
          <div className="ai-provider-summary">
            <div className="ai-provider-title-row">
              <span className="ai-provider-name">{source.title}</span>
              <span
                className={`ai-model-row-standard ${
                  source.signedIn
                    ? "ai-model-row-standard-active"
                    : "ai-model-row-standard-anthropic"
                }`}
              >
                {source.signedIn
                  ? t("settings.agentSources.signedIn")
                  : t("settings.agentSources.signedOut")}
              </span>
              <span className="ai-provider-model-count">
                {t("settings.aiModels.enabledCount", {
                  enabled: sourceEnabled ? enabledCount : 0,
                  total: source.models.length,
                })}
              </span>
            </div>
            <div className="ai-provider-facts">
              <span className="ai-model-row-baseurl">
                {source.account
                  ? t("settings.agentSources.account", { name: source.account })
                  : t("settings.agentSources.signedOut")}
              </span>
              <span className="ai-model-row-sep">·</span>
              <span>
                {t("settings.agentSources.tokenExpires", {
                  time: formatExpiry(source.tokenExpiresAtMs),
                })}
              </span>
              <span className="ai-model-row-sep">·</span>
              <span>{catalogLabel(source.catalogSource, t)}</span>
              <span className="ai-model-row-sep">·</span>
              <span>{balanceText(credits, t)}</span>
              {packages.length > 0 ? (
                <>
                  <span className="ai-model-row-sep">·</span>
                  <button
                    type="button"
                    className="ai-provider-packages-open"
                    onClick={() => setPackagesOpen(true)}
                  >
                    {t("settings.agentSources.packageCount", { count: packages.length })}
                  </button>
                </>
              ) : null}
            </div>
            {credits?.cycleResetTime && !credits.error ? (
              <div className="ai-provider-facts">
                <span>
                  {t("settings.agentSources.cycleReset", { time: credits.cycleResetTime })}
                </span>
              </div>
            ) : null}
          </div>
        </div>
        <div className="ai-model-row-actions">
          <WorkbenchActionButton
            icon
            disabled={refreshing}
            title={t("settings.agentSources.refresh")}
            aria-label={t("settings.agentSources.refresh")}
            onClick={onRefresh}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              width="14"
              height="14"
              className={refreshing ? "icon-spin" : undefined}
              aria-hidden
            >
              <path d="M23 4v6h-6M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
            </svg>
          </WorkbenchActionButton>
          <ModelToggle
            enabled={sourceEnabled && source.signedIn}
            disabled={!source.signedIn}
            label={t("settings.agentSources.toggleSource", { name: source.title })}
            onChange={(next) => setSourceEnabled(source.id, next)}
          />
        </div>
      </div>

      {source.error ? (
        <div className="ai-provider-refresh-notice ai-provider-refresh-notice--err">{source.error}</div>
      ) : null}
      {credits?.error ? (
        <div className="ai-provider-refresh-notice ai-provider-refresh-notice--err">
          {t("settings.agentSources.balanceFailed")}: {credits.error}
        </div>
      ) : null}

      {expanded && hasModels ? (
        <AgentSourceModelGrid sourceId={source.id} models={source.models} sourceEnabled={sourceEnabled} />
      ) : null}

      <FormDialog
        open={packagesOpen}
        onClose={() => setPackagesOpen(false)}
        title={t("settings.agentSources.packageList")}
        subtitle={source.title}
        size="lg"
        cancelLabel={t("common.close")}
      >
        <ul className="ai-provider-package-list">
          {packages.map((item, index) => (
            <li key={`${source.id}-pkg-${index}`} className="ai-provider-package-row">
              <span className="ai-provider-package-name" title={item.name}>
                {item.name}
              </span>
              <span className="ai-provider-package-remain">
                {t("settings.agentSources.packageRemainValue", {
                  remain: formatCredit(item.remain),
                  size: formatCredit(item.size),
                })}
              </span>
            </li>
          ))}
        </ul>
      </FormDialog>
    </li>
  );
}

function AgentSourceModelGrid({
  sourceId,
  models,
  sourceEnabled,
}: {
  sourceId: string;
  models: AgentSourceModel[];
  sourceEnabled: boolean;
}) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const toggleAllRef = useRef<HTMLInputElement>(null);
  const disabledIds = useAgentSourcesStore(
    (s) => s.prefs[sourceId]?.disabledModelIds ?? NO_DISABLED_MODELS,
  );
  const setModelEnabled = useAgentSourcesStore((s) => s.setModelEnabled);
  const setAllModelsEnabled = useAgentSourcesStore((s) => s.setAllModelsEnabled);

  const filtered = useMemo(
    () =>
      models.filter((model) =>
        fuzzyMatchModelName(`${model.name} ${model.id} ${model.credits ?? ""}`, search),
      ),
    [models, search],
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / MODEL_PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageItems = filtered.slice(safePage * MODEL_PAGE_SIZE, safePage * MODEL_PAGE_SIZE + MODEL_PAGE_SIZE);
  const enabledCount = models.filter((model) => !disabledIds.includes(model.id)).length;
  const allEnabled = models.length > 0 && enabledCount === models.length;
  const someEnabled = enabledCount > 0 && !allEnabled;

  useEffect(() => {
    const el = toggleAllRef.current;
    if (!el) return;
    el.indeterminate = someEnabled;
  }, [someEnabled]);

  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);

  return (
    <div className="ai-provider-models-panel">
      <div className="ai-provider-models-toolbar">
        <div className="ai-provider-models-search">
          <TextInput
            className="input input-search"
            value={search}
            onChange={(value) => {
              setSearch(value);
              setPage(0);
            }}
            clearable={false}
            copyable={false}
            placeholder={t("settings.aiModels.modelList.searchPlaceholder")}
          />
        </div>
        <label className="ai-provider-models-bulk">
          <input
            ref={toggleAllRef}
            type="checkbox"
            checked={sourceEnabled && allEnabled}
            disabled={!sourceEnabled || models.length === 0}
            onChange={(event) =>
              setAllModelsEnabled(
                sourceId,
                models.map((model) => model.id),
                event.target.checked,
              )
            }
            aria-label={t("settings.aiModels.modelList.toggleAll")}
          />
          <span>{t("settings.aiModels.modelList.toggleAll")}</span>
        </label>
      </div>
      <div className="ai-provider-models-summary">
        {t("settings.aiModels.modelList.enabledSummary", {
          enabled: sourceEnabled ? enabledCount : 0,
          total: models.length,
          filtered: search.trim() ? filtered.length : models.length,
        })}
      </div>
      {filtered.length === 0 ? (
        <div className="ai-provider-models-empty">{t("settings.aiModels.modelList.noMatch")}</div>
      ) : (
        <>
          <ul className="ai-provider-models">
            {pageItems.map((model, index) => {
              const enabled = sourceEnabled && !disabledIds.includes(model.id);
              return (
                <li key={`${model.id}-${safePage}-${index}`} className="ai-provider-model-item">
                  <div className="ai-provider-model-item-main">
                    <div className="ai-provider-model-name-row">
                      <span className="ai-provider-model-name" title={model.id}>
                        {model.name}
                      </span>
                      {model.badges.map((badge, badgeIndex) => (
                        <span
                          key={`${model.id}-badge-${badgeIndex}`}
                          className="ai-provider-model-source-tag"
                        >
                          {badge}
                        </span>
                      ))}
                      {model.credits ? (
                        <span
                          className="ai-provider-model-source-tag ai-provider-model-source-tag--api"
                          title={tokenPriceTitle(model.credits)}
                        >
                          {model.credits}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="ai-provider-model-item-actions">
                    <ModelToggle
                      enabled={enabled}
                      disabled={!sourceEnabled}
                      label={t("settings.aiModels.modelList.toggleModel", { name: model.name })}
                      onChange={(next) => setModelEnabled(sourceId, model.id, next)}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
          {totalPages > 1 ? (
            <div className="ai-provider-models-pagination">
              <WorkbenchActionButton
                disabled={safePage <= 0}
                onClick={() => setPage((current) => Math.max(0, current - 1))}
              >
                {t("settings.aiModels.modelList.prevPage")}
              </WorkbenchActionButton>
              <span className="ai-provider-models-page-info">
                {t("settings.aiModels.modelList.pageInfo", {
                  page: safePage + 1,
                  total: totalPages,
                })}
              </span>
              <WorkbenchActionButton
                disabled={safePage >= totalPages - 1}
                onClick={() => setPage((current) => Math.min(totalPages - 1, current + 1))}
              >
                {t("settings.aiModels.modelList.nextPage")}
              </WorkbenchActionButton>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
