import { useMemo } from "react";

import { Select } from "../../ui/Select";
import { useI18n } from "../../../i18n";
import { modelSelectTitle, useBackendSelectOptions } from "../../../lib/ai/backendSelectOptions";
import { rememberRecentModelIds, withRecentModelGroup } from "../../../lib/ai/recentModelOptions";
import {
  resolveConversationModelSelectionId,
  useAssistantScenarioModelSelectionId,
} from "../../../lib/aiScenarioModels";
import { useAiModelsStore } from "../../../stores/aiModelsStore";
import { useAiStore } from "../../../stores/aiStore";
import { useSettingsStore } from "../../../stores/settingsStore";

/** 输入区：当前会话（或无会话时的草稿）模型选择 */
export function AiConversationModelSelect() {
  const { t } = useI18n();
  const providers = useAiModelsStore((s) => s.providers);
  const activeConversationId = useAiStore((s) => s.activeConversationId);
  const activeConversation = useAiStore((s) =>
    s.conversations.find((c) => c.id === s.activeConversationId),
  );
  const isGenerating = useAiStore((s) => s.isGenerating);
  const draftModelSelectionId = useAiStore((s) => s.currentModelSelectionId);
  const setDraftModelSelectionId = useAiStore((s) => s.setCurrentModelSelectionId);
  const setConversationModelSelectionId = useAiStore((s) => s.setConversationModelSelectionId);
  const assistantDefaultId = useSettingsStore((s) => s.aiScenarioAssistantModelSelectionId);
  const fallbackSelectionId = useAssistantScenarioModelSelectionId();
  const backendOptions = useBackendSelectOptions(providers);
  const recentModelIds = useSettingsStore((s) => s.aiRecentModelSelectionIds);
  const rememberRecentModel = useSettingsStore((s) => s.rememberRecentModel);

  const flatModelOptions = useMemo(
    () =>
      backendOptions
        .filter((opt) => opt.installed !== false)
        .map((opt) => ({
          value: opt.value,
          label: opt.label,
          subtitle: opt.subtitle,
          meta: opt.meta,
          title: modelSelectTitle(opt.label, opt.meta, opt.subtitle),
        })),
    [backendOptions],
  );

  const modelValue = useMemo(() => {
    const resolved = resolveConversationModelSelectionId(
      providers,
      activeConversation,
      assistantDefaultId,
      draftModelSelectionId,
    );
    if (resolved && flatModelOptions.some((o) => o.value === resolved)) {
      return resolved;
    }
    if (
      fallbackSelectionId &&
      flatModelOptions.some((o) => o.value === fallbackSelectionId)
    ) {
      return fallbackSelectionId;
    }
    return flatModelOptions[0]?.value ?? "";
  }, [
    activeConversation,
    assistantDefaultId,
    draftModelSelectionId,
    fallbackSelectionId,
    flatModelOptions,
    providers,
  ]);

  const modelOptions = useMemo(
    () =>
      withRecentModelGroup(
        flatModelOptions,
        modelValue ? rememberRecentModelIds(recentModelIds, modelValue) : recentModelIds,
        t("ai.modelSelect.recent"),
      ),
    [flatModelOptions, modelValue, recentModelIds, t],
  );

  const handleChange = (next: string) => {
    rememberRecentModel(next);
    if (activeConversationId) {
      setConversationModelSelectionId(activeConversationId, next);
      return;
    }
    setDraftModelSelectionId(next);
  };

  if (flatModelOptions.length === 0) {
    return (
      <span className="ai-model-select-empty" title={t("ai.modelSelect.empty")}>
        {t("ai.modelSelect.empty")}
      </span>
    );
  }

  return (
    <Select
      className="ai-model-select"
      value={modelValue}
      onChange={handleChange}
      options={modelOptions}
      size="sm"
      borderless
      searchable={modelOptions.length > 8}
      disabled={isGenerating}
      panelMinWidth={280}
      panelZIndex={1400}
      aria-label={t("ai.modelSelect.label")}
      title={t("ai.modelSelect.label")}
    />
  );
}
