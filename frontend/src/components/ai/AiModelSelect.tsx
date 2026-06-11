import { useMemo } from "react";

import { useI18n } from "../../i18n";
import {
  listModelSelections,
  parseModelSelectionId,
  useAiModelsStore,
} from "../../stores/aiModelsStore";
import { useAiStore } from "../../stores/aiStore";
import { Select } from "../ui/Select";

export interface AiModelSelectProps {
  disabled?: boolean;
  className?: string;
}

/** AI 助手模型选择（数据来自设置 → AI 模型） */
export function AiModelSelect({ disabled = false, className }: AiModelSelectProps) {
  const { t } = useI18n();
  const providers = useAiModelsStore((s) => s.providers);
  const currentModelSelectionId = useAiStore((s) => s.currentModelSelectionId);
  const setCurrentModelSelectionId = useAiStore((s) => s.setCurrentModelSelectionId);

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
      <span className="ai-model-select-empty">{t("ai.modelSelect.empty")}</span>
    );
  }

  const value =
    currentModelSelectionId && options.some((o) => o.value === currentModelSelectionId)
      ? currentModelSelectionId
      : options[0]!.value;

  return (
    <Select
      value={value}
      onChange={setCurrentModelSelectionId}
      options={options}
      size="sm"
      borderless
      disabled={disabled}
      searchable={options.length > 6}
      aria-label={t("ai.modelSelect.label")}
      className={["ai-model-select", className].filter(Boolean).join(" ")}
    />
  );
}

/** 当前选中模型的显示名（用于标题等） */
export function useSelectedModelLabel(): string | null {
  const providers = useAiModelsStore((s) => s.providers);
  const currentModelSelectionId = useAiStore((s) => s.currentModelSelectionId);

  return useMemo(() => {
    if (!currentModelSelectionId) return null;
    const parsed = parseModelSelectionId(currentModelSelectionId);
    if (!parsed) return null;
    const provider = providers.find((p) => p.id === parsed.providerId);
    if (!provider) return null;
    return parsed.modelName;
  }, [currentModelSelectionId, providers]);
}
