import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/Button";
import { useI18n } from "../../i18n";
import {
  countEnabledModels,
  isModelEnabled,
  useAiModelsStore,
  type AiModelProvider,
} from "../../stores/aiModelsStore";
import { fuzzyMatchModelName } from "../../lib/fetchProviderModels";

const PAGE_SIZE = 15;

function ModelToggle({
  enabled,
  onChange,
  label,
}: {
  enabled: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={`toggle${enabled ? " on" : ""}`}
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      onClick={() => onChange(!enabled)}
    />
  );
}

interface ProviderModelListProps {
  provider: AiModelProvider;
}

export function ProviderModelList({ provider }: ProviderModelListProps) {
  const { t } = useI18n();
  const setModelEnabled = useAiModelsStore((s) => s.setModelEnabled);
  const setAllModelsEnabled = useAiModelsStore((s) => s.setAllModelsEnabled);

  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const toggleAllRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(
    () => provider.modelNames.filter((name) => fuzzyMatchModelName(name, search)),
    [provider.modelNames, search],
  );

  useEffect(() => {
    setPage(0);
  }, [search, provider.id, provider.modelNames.length]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageItems = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const enabledCount = countEnabledModels(provider);
  const totalCount = provider.modelNames.length;
  const allEnabled = totalCount > 0 && enabledCount === totalCount;
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
        <input
          className="input input-search ai-provider-models-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("settings.aiModels.modelList.searchPlaceholder")}
        />
        <label className="ai-provider-models-bulk">
          <input
            ref={toggleAllRef}
            type="checkbox"
            checked={allEnabled}
            disabled={totalCount === 0}
            onChange={(e) => setAllModelsEnabled(provider.id, e.target.checked)}
            aria-label={t("settings.aiModels.modelList.toggleAll")}
          />
          <span>{t("settings.aiModels.modelList.toggleAll")}</span>
        </label>
      </div>

      <div className="ai-provider-models-summary">
        {t("settings.aiModels.modelList.enabledSummary", {
          enabled: enabledCount,
          total: provider.modelNames.length,
          filtered: search.trim() ? filtered.length : provider.modelNames.length,
        })}
      </div>

      {filtered.length === 0 ? (
        <div className="ai-provider-models-empty">{t("settings.aiModels.modelList.noMatch")}</div>
      ) : (
        <>
          <ul className="ai-provider-models">
            {pageItems.map((modelName) => {
              const enabled = isModelEnabled(provider, modelName);
              return (
                <li key={modelName} className="ai-provider-model-item">
                  <span className="ai-provider-model-name" title={modelName}>
                    {modelName}
                  </span>
                  <ModelToggle
                    enabled={enabled}
                    label={t("settings.aiModels.modelList.toggleModel", { name: modelName })}
                    onChange={(next) => setModelEnabled(provider.id, modelName, next)}
                  />
                </li>
              );
            })}
          </ul>

          {totalPages > 1 && (
            <div className="ai-provider-models-pagination">
              <Button
                variant="ghost"
                size="sm"
                disabled={safePage <= 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                {t("settings.aiModels.modelList.prevPage")}
              </Button>
              <span className="ai-provider-models-page-info">
                {t("settings.aiModels.modelList.pageInfo", {
                  page: safePage + 1,
                  total: totalPages,
                })}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={safePage >= totalPages - 1}
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              >
                {t("settings.aiModels.modelList.nextPage")}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
