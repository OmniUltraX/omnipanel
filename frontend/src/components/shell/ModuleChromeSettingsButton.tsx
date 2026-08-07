import { useI18n } from "../../i18n";
import { parseModuleWindowParams } from "../../lib/moduleWindow";
import { useSettingsUiStore } from "../../stores/settingsUiStore";
import { IconSettings } from "../ui/icons/Icons";

/**
 * 独立模块窗右上角：AI 助手旁的设置入口（主窗有侧栏用户菜单，无需此按钮）。
 */
export function ModuleChromeSettingsButton() {
  const { t } = useI18n();
  const inModuleWindow = Boolean(parseModuleWindowParams()?.moduleKey);
  const openSettings = useSettingsUiStore((s) => s.openSettings);

  if (!inModuleWindow) return null;

  return (
    <button
      type="button"
      className="dock-chrome-settings-btn drag-ignore"
      title={t("routes.settings")}
      aria-label={t("routes.settings")}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openSettings();
      }}
    >
      <IconSettings size={14} />
    </button>
  );
}
