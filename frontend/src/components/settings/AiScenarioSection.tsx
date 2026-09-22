import { useMemo } from "react";

import { useI18n } from "../../i18n";
import { useBackendSelectOptions } from "../../lib/ai/backendSelectOptions";
import { useSettingsStore } from "../../stores/settingsStore";
import { Select } from "../ui/Select";

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
  const cliOptions = useBackendSelectOptions([]);
  const options = useMemo(
    () =>
      cliOptions
        .filter((opt) => opt.installed !== false && (opt.group === "cli" || opt.group === "opencode"))
        .map((opt) => ({
          value: opt.value,
          label: opt.label,
        })),
    [cliOptions],
  );
  const assistantModelId = useSettingsStore((s) => s.aiScenarioAssistantModelSelectionId);
  const setAiScenarioSettings = useSettingsStore((s) => s.setAiScenarioSettings);

  return (
    <div className="settings-section">
      <h2>{t("settings.aiScenarios.title")}</h2>

      {options.length === 0 ? (
        <p className="settings-ai-scenario-empty">{t("settings.aiScenarios.noModel")}</p>
      ) : (
        <div className="setting-row">
          <div className="setting-label">
            <h4>{t("settings.aiScenarios.assistant.label")}</h4>
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
      )}
    </div>
  );
}
