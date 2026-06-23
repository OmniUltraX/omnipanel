import { useMemo } from "react";

import { useI18n } from "../../i18n";
import {
  listModelSelections,
  parseModelSelectionId,
  useAiModelsStore,
} from "../../stores/aiModelsStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { Select } from "../ui/Select";

export interface KnowledgeEmbeddingModelSelectProps {
  disabled?: boolean;
  className?: string;
}

/** 知识库向量化 embedding 模型选择（数据来自设置 → AI 模型） */
export function KnowledgeEmbeddingModelSelect({
  disabled = false,
  className,
}: KnowledgeEmbeddingModelSelectProps) {
  const { t } = useI18n();
  const providers = useAiModelsStore((s) => s.providers);
  const selectionId = useSettingsStore((s) => s.knowledgeEmbeddingModelSelectionId);
  const setKnowledgeSettings = useSettingsStore((s) => s.setKnowledgeSettings);

  const options = useMemo(() => {
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

  if (options.length === 0) {
    return (
      <span className="knowledge-embedding-model-empty">
        {t("knowledge.vectorize.noModel")}
      </span>
    );
  }

  const value =
    selectionId && options.some((o) => o.value === selectionId)
      ? selectionId
      : options[0]!.value;

  return (
    <Select
      value={value}
      onChange={(next) => setKnowledgeSettings({ knowledgeEmbeddingModelSelectionId: next })}
      options={options}
      size="sm"
      disabled={disabled}
      searchable={options.length > 6}
      aria-label={t("knowledge.vectorize.modelLabel")}
      className={["knowledge-embedding-model-select", className].filter(Boolean).join(" ")}
    />
  );
}

export function useKnowledgeEmbeddingModelSelectionId(): string | null {
  const providers = useAiModelsStore((s) => s.providers);
  const selectionId = useSettingsStore((s) => s.knowledgeEmbeddingModelSelectionId);
  const options = useMemo(() => listModelSelections(providers), [providers]);
  if (options.length === 0) {
    return null;
  }
  if (selectionId && options.some((item) => item.id === selectionId)) {
    return selectionId;
  }
  return options[0]!.id;
}
