import { SubWindow } from "../ui/window/SubWindow";
import { SettingsPanel } from "../../modules/settings/SettingsPanel";
import { useSettingsUiStore } from "../../stores/settingsUiStore";
import { useI18n } from "../../i18n";

export function SettingsWindow() {
  const { t } = useI18n();
  const open = useSettingsUiStore((s) => s.open);
  const closeSettings = useSettingsUiStore((s) => s.closeSettings);

  return (
    <SubWindow
      open={open}
      title={t("routes.settings")}
      onClose={closeSettings}
      className="settings-subwindow"
      widthRatio={0.88}
      heightRatio={0.85}
    >
      <SettingsPanel />
    </SubWindow>
  );
}
