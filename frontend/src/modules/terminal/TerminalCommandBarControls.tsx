import { useEffect, useMemo } from "react";

import { useI18n } from "../../i18n";
import { modelSelectTitle, useBackendSelectOptions } from "../../lib/ai/backendSelectOptions";
import { rememberRecentModelIds, withRecentModelGroup } from "../../lib/ai/recentModelOptions";
import { useAiModelsStore } from "../../stores/aiModelsStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useTerminalModelSelectionId } from "../../lib/terminalScenarioModels";
import { Select } from "../../components/ui/form/Select";
import type { TerminalApprovalMode } from "./terminalApprovalPolicy";
import { useTerminalApprovalMode } from "./terminalApprovalSettings";

type TerminalCommandBarControlsProps = {
  disabled?: boolean;
  className?: string;
};

const APPROVAL_MODES: TerminalApprovalMode[] = ["strict", "view", "loose"];

export function TerminalCommandBarControls({
  disabled = false,
  className,
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

  const savedModelId = useSettingsStore((s) => s.aiScenarioTerminalModelSelectionId);
  const modelValue =
    savedModelId && flatModelOptions.some((o) => o.value === savedModelId)
      ? savedModelId
      : modelSelectionId && flatModelOptions.some((o) => o.value === modelSelectionId)
        ? modelSelectionId
        : flatModelOptions[0]?.value ?? "";
  const modelOptions = useMemo(
    () =>
      withRecentModelGroup(
        flatModelOptions,
        modelValue ? rememberRecentModelIds(recentModelIds, modelValue) : recentModelIds,
        t("ai.modelSelect.recent"),
      ),
    [flatModelOptions, modelValue, recentModelIds, t],
  );

  useEffect(() => {
    if (savedModelId) rememberRecentModel(savedModelId);
  }, [rememberRecentModel, savedModelId]);

  return (
    <div className={className ? `term-cmd-toolbar ${className}` : "term-cmd-toolbar"}>
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
          onChange={(next) => {
            rememberRecentModel(next);
            setGlobalTerminalModel({ aiScenarioTerminalModelSelectionId: next });
          }}
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
