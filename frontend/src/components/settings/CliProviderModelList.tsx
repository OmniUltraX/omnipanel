import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../ui/Button";
import { TextInput } from "../ui/TextInput";
import { useI18n } from "../../i18n";
import { fuzzyMatchModelName } from "../../lib/fetchProviderModels";
import {
  countEnabledCliModels,
  getCliProviderModels,
  isCliModelEnabled,
  isManualCliModel,
  useCliProvidersStore,
} from "../../stores/cliProvidersStore";

const PAGE_SIZE = 21;

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

interface CliProviderModelListProps {
  providerId: string;
}

export function CliProviderModelList({ providerId }: CliProviderModelListProps) {
  const { t } = useI18n();
  const provider = useCliProvidersStore((s) => s.providers.find((p) => p.id === providerId));
  const modelCache = useCliProvidersStore((s) => s.modelCache);
  const setModelEnabled = useCliProvidersStore((s) => s.setModelEnabled);
  const setAllModelsEnabled = useCliProvidersStore((s) => s.setAllModelsEnabled);
  const addManualModel = useCliProvidersStore((s) => s.addManualModel);
  const removeModel = useCliProvidersStore((s) => s.removeModel);

  const models = provider ? getCliProviderModels(provider, modelCache) : [];
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [manualInput, setManualInput] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [confirmDeleteModel, setConfirmDeleteModel] = useState<string | null>(null);
  const toggleAllRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(
    () => models.filter((name) => fuzzyMatchModelName(name, search)),
    [models, search],
  );

  useEffect(() => {
    setPage(0);
    setSearch("");
    setManualInput("");
    setAddError(null);
    setConfirmDeleteModel(null);
  }, [providerId]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageItems = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const enabledCount = provider ? countEnabledCliModels(provider, models) : 0;
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

  if (!provider) return null;

  const handleAddManual = async () => {
    const result = await addManualModel(provider.id, manualInput);
    if (!result.ok) {
      if (result.error === "empty") {
        setAddError(t("settings.aiModels.modelList.addEmpty"));
      } else if (result.error === "duplicate") {
        setAddError(t("settings.aiModels.modelList.addDuplicate", { name: manualInput.trim() }));
      } else {
        setAddError(result.error);
      }
      return;
    }
    setManualInput("");
    setAddError(null);
  };

  return (
    <div className="ai-provider-models-panel">
      <div className="ai-provider-models-toolbar">
        <TextInput
          className="input input-search ai-provider-models-search"
          value={search}
          onChange={setSearch}
          copyable={false}
          placeholder={t("settings.aiModels.modelList.searchPlaceholder")}
        />
        <TextInput
          className="input ai-provider-models-add-input"
          value={manualInput}
          onChange={(value) => {
            setManualInput(value);
            setAddError(null);
          }}
          placeholder={t("settings.cliProviders.modelList.addPlaceholder")}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void handleAddManual();
            }
          }}
        />
        <Button variant="secondary" size="sm" onClick={() => void handleAddManual()}>
          {t("settings.aiModels.modelList.addBtn")}
        </Button>
        <label className="ai-provider-models-bulk">
          <input
            ref={toggleAllRef}
            type="checkbox"
            checked={allEnabled}
            disabled={models.length === 0 || !provider.enabled}
            onChange={(e) => void setAllModelsEnabled(provider.id, e.target.checked)}
            aria-label={t("settings.aiModels.modelList.toggleAll")}
          />
          <span>{t("settings.aiModels.modelList.toggleAll")}</span>
        </label>
      </div>
      {addError ? <div className="form-error ai-provider-models-add-error">{addError}</div> : null}

      <div className="ai-provider-models-summary">
        {t("settings.aiModels.modelList.enabledSummary", {
          enabled: enabledCount,
          total: models.length,
          filtered: search.trim() ? filtered.length : models.length,
        })}
      </div>

      {!provider.enabled ? (
        <div className="ai-provider-models-empty setting-hint">{t("settings.cliProviders.providerDisabled")}</div>
      ) : null}

      {filtered.length === 0 ? (
        <div className="ai-provider-models-empty">{t("settings.aiModels.modelList.noMatch")}</div>
      ) : (
        <>
          <ul className="ai-provider-models">
            {pageItems.map((modelName) => {
              const enabled = isCliModelEnabled(provider, modelName);
              const manual = isManualCliModel(provider, modelName);
              return (
                <li key={modelName} className="ai-provider-model-item">
                  <div className="ai-provider-model-item-main">
                    <div className="ai-provider-model-name-row">
                      <span className="ai-provider-model-name" title={modelName}>
                        {modelName}
                      </span>
                      <span
                        className={`ai-provider-model-source-tag ai-provider-model-source-tag--${manual ? "manual" : "api"}`}
                      >
                        {manual
                          ? t("settings.aiModels.modelList.tagManual")
                          : t("settings.cliProviders.modelList.tagDiscovered")}
                      </span>
                    </div>
                  </div>

                  {confirmDeleteModel === modelName ? (
                    <div className="ai-provider-model-delete-confirm">
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => void removeModel(provider.id, modelName)}
                      >
                        {t("settings.aiModels.confirmDelete")}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteModel(null)}>
                        {t("settings.aiModels.cancelDelete")}
                      </Button>
                    </div>
                  ) : (
                    <div className="ai-provider-model-item-actions">
                      <ModelToggle
                        enabled={Boolean(enabled && provider.enabled)}
                        label={t("settings.aiModels.modelList.toggleModel", { name: modelName })}
                        onChange={(next) => {
                          if (!provider.enabled) return;
                          void setModelEnabled(provider.id, modelName, next);
                        }}
                      />
                      <div className="ai-provider-model-item-btns">
                        {manual ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="ai-provider-model-item-btn ai-model-row-delete"
                            title={t("settings.aiModels.deleteBtn")}
                            aria-label={t("settings.aiModels.modelList.deleteModel", { name: modelName })}
                            onClick={() => setConfirmDeleteModel(modelName)}
                          >
                            <svg
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              width="14"
                              height="14"
                              aria-hidden
                            >
                              <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                            </svg>
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          {totalPages > 1 ? (
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
          ) : null}
        </>
      )}
    </div>
  );
}
