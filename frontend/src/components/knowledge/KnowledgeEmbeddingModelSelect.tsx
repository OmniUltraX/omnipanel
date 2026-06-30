import { useCallback, useEffect, useMemo, useState } from "react";

import { useI18n } from "../../i18n";
import {
  fetchOllamaModelNames,
  isKnowledgeEmbeddingOllamaBaseUrlReady,
  isKnowledgeEmbeddingOllamaModelReady,
  KNOWLEDGE_EMBEDDING_OLLAMA_PROVIDER_ID,
  normalizeOllamaBaseUrl,
  OLLAMA_DEFAULT_BASE_URL,
  resolveConfiguredEmbeddingSelectionId,
  resolveKnowledgeEmbeddingProvider,
  type KnowledgeEmbeddingModelMode,
} from "../../lib/knowledgeEmbeddingModel";
import {
  listModelSelections,
  parseModelSelectionId,
  useAiModelsStore,
} from "../../stores/aiModelsStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { Button } from "../ui/Button";
import { Select } from "../ui/Select";
import { TextInput } from "../ui/TextInput";

export interface KnowledgeEmbeddingModelSelectProps {
  disabled?: boolean;
  className?: string;
}

const MODE_OPTIONS: KnowledgeEmbeddingModelMode[] = ["configured", "ollama"];

/** 知识库默认 Embedding 模型配置（已配置列表 / Ollama） */
export function KnowledgeEmbeddingModelSelect({
  disabled = false,
  className,
}: KnowledgeEmbeddingModelSelectProps) {
  const { t } = useI18n();
  const providers = useAiModelsStore((s) => s.providers);
  const mode = useSettingsStore((s) => s.knowledgeEmbeddingModelMode);
  const selectionId = useSettingsStore((s) => s.knowledgeEmbeddingModelSelectionId);
  const ollamaModel = useSettingsStore((s) => s.knowledgeEmbeddingOllamaModel);
  const setKnowledgeSettings = useSettingsStore((s) => s.setKnowledgeSettings);

  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaModelsLoading, setOllamaModelsLoading] = useState(false);
  const [ollamaModelsError, setOllamaModelsError] = useState(false);

  const configuredOptions = useMemo(() => {
    return listModelSelections(providers).map(({ id }) => {
      const parsed = parseModelSelectionId(id);
      const provider = providers.find((p) => p.id === parsed?.providerId);
      const modelName = parsed?.modelName ?? id;
      const standard =
        provider?.apiStandard === "anthropic" ? "Anthropic" : "OpenAI";
      return {
        value: id,
        label: modelName,
        subtitle: provider ? `${provider.providerName} · ${standard}` : undefined,
      };
    });
  }, [providers]);

  const configuredValue = resolveConfiguredEmbeddingSelectionId(providers, selectionId) ?? "";

  const refreshOllamaModels = useCallback(async () => {
    const baseUrl = ollamaModel.baseUrl.trim();
    if (!baseUrl || !isKnowledgeEmbeddingOllamaBaseUrlReady(baseUrl)) {
      setOllamaModels([]);
      setOllamaModelsError(false);
      return;
    }
    setOllamaModelsLoading(true);
    setOllamaModelsError(false);
    const models = await fetchOllamaModelNames(baseUrl);
    setOllamaModels(models);
    setOllamaModelsError(models.length === 0);
    setOllamaModelsLoading(false);
  }, [ollamaModel.baseUrl]);

  useEffect(() => {
    if (mode !== "ollama") {
      return;
    }
    void refreshOllamaModels();
  }, [mode, ollamaModel.baseUrl, refreshOllamaModels]);

  const updateOllamaModel = (patch: Partial<typeof ollamaModel>) => {
    setKnowledgeSettings({
      knowledgeEmbeddingOllamaModel: { ...ollamaModel, ...patch },
    });
  };

  const ollamaModelOptions = useMemo(
    () =>
      ollamaModels.map((name) => ({
        value: name,
        label: name,
      })),
    [ollamaModels],
  );

  const ollamaModelValue = ollamaModel.modelName.trim();
  const showOllamaSelect =
    ollamaModelOptions.length > 0 &&
    (!ollamaModelValue || ollamaModelOptions.some((item) => item.value === ollamaModelValue));

  return (
    <div
      className={["knowledge-embedding-settings", className].filter(Boolean).join(" ")}
    >
      <div
        className="form-radio-group knowledge-embedding-mode-group"
        role="radiogroup"
        aria-label={t("settings.knowledge.embeddingModel")}
      >
        {MODE_OPTIONS.map((option) => (
          <label key={option} className="form-radio-option">
            <input
              type="radio"
              name="knowledge-embedding-mode"
              value={option}
              checked={mode === option}
              disabled={disabled}
              onChange={() => setKnowledgeSettings({ knowledgeEmbeddingModelMode: option })}
            />
            <span>{t(`settings.knowledge.embeddingModelMode.${option}`)}</span>
          </label>
        ))}
      </div>

      {mode === "configured" ? (
        configuredOptions.length === 0 ? (
          <p className="knowledge-embedding-model-empty">
            {t("settings.knowledge.embeddingConfiguredEmpty")}
          </p>
        ) : (
          <Select
            value={configuredValue}
            onChange={(next) =>
              setKnowledgeSettings({ knowledgeEmbeddingModelSelectionId: next })
            }
            options={configuredOptions}
            size="sm"
            disabled={disabled}
            searchable={configuredOptions.length > 6}
            aria-label={t("knowledge.vectorize.modelLabel")}
            className="knowledge-embedding-model-select"
          />
        )
      ) : (
        <div className="knowledge-embedding-ollama-form">
          <div className="form-field">
            <label htmlFor="knowledge-embedding-ollama-base-url">
              {t("settings.knowledge.embeddingOllamaBaseUrl")}
            </label>
            <TextInput
              id="knowledge-embedding-ollama-base-url"
              className="input"
              value={ollamaModel.baseUrl}
              disabled={disabled}
              placeholder={OLLAMA_DEFAULT_BASE_URL}
              onChange={(baseUrl) => updateOllamaModel({ baseUrl })}
              onBlur={() => {
                const normalized = normalizeOllamaBaseUrl(ollamaModel.baseUrl);
                if (normalized !== ollamaModel.baseUrl.trim()) {
                  updateOllamaModel({ baseUrl: normalized });
                }
              }}
            />
          </div>
          <div className="form-field">
            <div className="knowledge-embedding-ollama-model-row">
              <label htmlFor="knowledge-embedding-ollama-model-name">
                {t("settings.knowledge.embeddingOllamaModelName")}
              </label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled || ollamaModelsLoading}
                onClick={() => void refreshOllamaModels()}
              >
                {ollamaModelsLoading
                  ? t("settings.knowledge.embeddingOllamaRefreshing")
                  : t("settings.knowledge.embeddingOllamaRefresh")}
              </Button>
            </div>
            {showOllamaSelect ? (
              <Select
                value={ollamaModelValue || ollamaModelOptions[0]!.value}
                onChange={(next) => updateOllamaModel({ modelName: next })}
                options={ollamaModelOptions}
                size="sm"
                disabled={disabled}
                searchable={ollamaModelOptions.length > 6}
                aria-label={t("settings.knowledge.embeddingOllamaModelName")}
                className="knowledge-embedding-model-select"
              />
            ) : (
              <TextInput
                id="knowledge-embedding-ollama-model-name"
                className="input"
                value={ollamaModel.modelName}
                disabled={disabled}
                placeholder={t("settings.knowledge.embeddingOllamaModelNamePlaceholder")}
                onChange={(modelName) => updateOllamaModel({ modelName })}
              />
            )}
          </div>
          <p className="form-field-hint">{t("settings.knowledge.embeddingOllamaHint")}</p>
          {ollamaModelsError && !ollamaModelsLoading ? (
            <p className="form-field-hint form-field-hint-warn">
              {t("settings.knowledge.embeddingOllamaUnreachable")}
            </p>
          ) : null}
          {!isKnowledgeEmbeddingOllamaModelReady(ollamaModel) ? (
            <p className="form-field-hint form-field-hint-warn">
              {t("settings.knowledge.embeddingOllamaIncomplete")}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** @deprecated 请使用 useKnowledgeEmbeddingProviderConfig */
export function useKnowledgeEmbeddingModelSelectionId(): string | null {
  const provider = useKnowledgeEmbeddingProviderConfig();
  if (!provider) {
    return null;
  }
  if (provider.providerId === KNOWLEDGE_EMBEDDING_OLLAMA_PROVIDER_ID) {
    return null;
  }
  return `${provider.providerId}::${provider.modelName}`;
}

export function useKnowledgeEmbeddingProviderConfig() {
  const providers = useAiModelsStore((s) => s.providers);
  const mode = useSettingsStore((s) => s.knowledgeEmbeddingModelMode);
  const selectionId = useSettingsStore((s) => s.knowledgeEmbeddingModelSelectionId);
  const ollamaModel = useSettingsStore((s) => s.knowledgeEmbeddingOllamaModel);

  return useMemo(
    () =>
      resolveKnowledgeEmbeddingProvider(providers, {
        knowledgeEmbeddingModelMode: mode,
        knowledgeEmbeddingModelSelectionId: selectionId,
        knowledgeEmbeddingOllamaModel: ollamaModel,
      }),
    [providers, mode, selectionId, ollamaModel],
  );
}
