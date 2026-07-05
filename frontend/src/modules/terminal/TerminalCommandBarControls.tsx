import { useMemo } from "react";

import { useI18n } from "../../i18n";
import { useBackendSelectOptions } from "../../lib/ai/backendSelectOptions";
import { useAiModelsStore } from "../../stores/aiModelsStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useTerminalModelSelectionId } from "../../lib/terminalScenarioModels";
import { Select } from "../../components/ui/form/Select";
import type { TerminalApprovalMode } from "./terminalApprovalPolicy";
import { useTerminalApprovalMode } from "./terminalApprovalSettings";

type TerminalCommandBarControlsProps = {
  disabled?: boolean;
};

const APPROVAL_MODES: TerminalApprovalMode[] = ["strict", "view", "loose"];

export function TerminalCommandBarControls({
  disabled = false,
}: TerminalCommandBarControlsProps) {
  const { t } = useI18n();
  const providers = useAiModelsStore((s) => s.providers);
  const approvalMode = useTerminalApprovalMode();
  const setGlobalApprovalMode = useSettingsStore((s) => s.setTerminalApprovalMode);
  const setGlobalTerminalModel = useSettingsStore((s) => s.setAiScenarioSettings);
  const modelSelectionId = useTerminalModelSelectionId();
  const backendOptions = useBackendSelectOptions(providers);

  const approvalOptions = useMemo(
    () =>
      APPROVAL_MODES.map((value) => ({
        value,
        label: t(`terminal.command.approval.${value}`),
        title: t(`terminal.command.approval.${value}Desc`),
      })),
    [t],
  );

  const modelOptions = useMemo(
    () =>
      backendOptions
        .filter((opt) => opt.installed !== false)
        .map((opt) => ({
          value: opt.value,
          label: opt.group === "cli" ? `[CLI] ${opt.label}` : opt.label,
          title: opt.subtitle ?? opt.label,
        })),
    [backendOptions],
  );

  const savedModelId = useSettingsStore((s) => s.aiScenarioTerminalModelSelectionId);
  const modelValue =
    savedModelId && modelOptions.some((o) => o.value === savedModelId)
      ? savedModelId
      : modelSelectionId && modelOptions.some((o) => o.value === modelSelectionId)
        ? modelSelectionId
        : modelOptions[0]?.value ?? "";

  return (
    <div className="term-cmd-toolbar">
      <Select
        value={approvalMode}
        onChange={(next) => setGlobalApprovalMode(next as TerminalApprovalMode)}
        options={approvalOptions}
        size="sm"
        borderless
        searchable={false}
        disabled={disabled}
        panelMinWidth={168}
        aria-label={t("terminal.command.approval.label")}
        title={t("terminal.command.approval.label")}
        className="term-cmd-toolbar__approval"
      />
      {modelOptions.length > 0 ? (
        <Select
          value={modelValue}
          onChange={(next) =>
            setGlobalTerminalModel({ aiScenarioTerminalModelSelectionId: next })
          }
          options={modelOptions}
          size="sm"
          borderless
          searchable={modelOptions.length > 8}
          disabled={disabled}
          panelMinWidth={280}
          aria-label={t("terminal.command.model.label")}
          title={t("terminal.command.model.label")}
          className="term-cmd-toolbar__model"
        />
      ) : (
        <span className="term-cmd-toolbar__model-empty">{t("ai.modelSelect.empty")}</span>
      )}
    </div>
  );
}
