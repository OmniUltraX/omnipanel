import { useI18n } from "../../i18n";
import { parseModuleWindowParams } from "../../lib/moduleWindow";
import { useSettingsUiStore } from "../../stores/settingsUiStore";
import { Button } from "../ui/primitives/Button";
import { IconSettings } from "../ui/icons/Icons";

/** 独立模块窗左栏顶栏：打开设置。主窗不再放「问 AI」。 */
export function ModuleLeftHeaderActions() {
  const { t } = useI18n();
  const inModuleWindow = Boolean(parseModuleWindowParams()?.moduleKey);
  const openSettings = useSettingsUiStore((s) => s.openSettings);

  if (!inModuleWindow) return null;

  return (
    <div className="module-left-header-actions">
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
    </div>
  );
}
