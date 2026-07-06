import { useMemo } from "react";

import { useI18n } from "../../i18n";
import {
  listModelSelections,
  parseModelSelectionId,
  useAiModelsStore,
} from "../../stores/aiModelsStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { Select } from "../ui/Select";

function useModelSelectOptions() {
  const providers = useAiModelsStore((s) => s.providers);

  return useMemo(() => {
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
}

function resolveSelectValue(
  options: { value: string }[],
  configuredId: string | null,
): string {
  if (configuredId && options.some((o) => o.value === configuredId)) {
    return configuredId;
  }
  return options[0]?.value ?? "";
}

export function AiScenarioSection() {
  const { t } = useI18n();
  const options = useModelSelectOptions();
  const formFillModelId = useSettingsStore((s) => s.aiScenarioFormFillModelSelectionId);
  const assistantModelId = useSettingsStore((s) => s.aiScenarioAssistantModelSelectionId);
  const setAiScenarioSettings = useSettingsStore((s) => s.setAiScenarioSettings);

  return (
    <div className="settings-section">
      <h2>{t("settings.aiScenarios.title")}</h2>
      <p className="section-desc">{t("settings.aiScenarios.description")}</p>

      {options.length === 0 ? (
        <p className="settings-ai-scenario-empty">{t("settings.aiScenarios.noModel")}</p>
      ) : (
        <>
          <div className="setting-row">
            <div className="setting-label">
              <h4>{t("settings.aiScenarios.formFill.label")}</h4>
              <p>{t("settings.aiScenarios.formFill.desc")}</p>
            </div>
            <Select
              className="setting-select settings-ai-scenario-select"
              size="sm"
              panelMinWidth={420}
              value={resolveSelectValue(options, formFillModelId)}
              onChange={(next) =>
                setAiScenarioSettings({ aiScenarioFormFillModelSelectionId: next })
              }
              options={options}
              searchable={options.length > 6}
              aria-label={t("settings.aiScenarios.formFill.label")}
            />
          </div>

          <div className="setting-row">
            <div className="setting-label">
              <h4>{t("settings.aiScenarios.assistant.label")}</h4>
              <p>{t("settings.aiScenarios.assistant.desc")}</p>
            </div>
            <Select
              className="setting-select settings-ai-scenario-select"
              size="sm"
              panelMinWidth={420}
              value={resolveSelectValue(options, assistantModelId)}
              onChange={(next) =>
                setAiScenarioSettings({ aiScenarioAssistantModelSelectionId: next })
              }
              options={options}
              searchable={options.length > 6}
              aria-label={t("settings.aiScenarios.assistant.label")}
            />
          </div>
        </>
      )}
    </div>
  );
}
