import { useI18n } from "../../i18n";
import type { ModuleKey } from "../../lib/paths";
import { parseModuleWindowParams } from "../../lib/moduleWindow";
import { useSettingsUiStore } from "../../stores/settingsUiStore";
import { Button } from "../ui/primitives/Button";
import { IconSettings } from "../ui/icons/Icons";
import { ModuleAskAiButton } from "./ModuleAskAiButton";

export interface ModuleLeftHeaderActionsProps {
  moduleKey: ModuleKey;
}

/** 模块左栏顶栏操作：问 AI；独立模块窗额外显示打开设置。 */
export function ModuleLeftHeaderActions({ moduleKey }: ModuleLeftHeaderActionsProps) {
  const { t } = useI18n();
  const inModuleWindow = Boolean(parseModuleWindowParams()?.moduleKey);
  const openSettings = useSettingsUiStore((s) => s.openSettings);

  return (
    <div className="module-left-header-actions">
      <ModuleAskAiButton moduleKey={moduleKey} />
      {inModuleWindow ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="module-open-settings-btn window-drag-surface--interactive"
          title={t("routes.settings")}
          aria-label={t("routes.settings")}
          onClick={() => openSettings()}
        >
          <IconSettings size={14} />
        </Button>
      ) : null}
    </div>
  );
}
