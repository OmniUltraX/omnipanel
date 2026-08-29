import { useNavigate } from "react-router-dom";
import { useI18n } from "../../i18n";
import { navigateToFeature } from "../../lib/workspaceNavigation";
import { PLUGINS_PATH } from "../../lib/paths";
import { useSettingsUiStore } from "../../stores/settingsUiStore";

export function PluginsSettingsSection() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const closeSettings = useSettingsUiStore((s) => s.closeSettings);

  return (
    <div className="settings-plugins">
      <div className="setting-row">
        <div className="setting-label">
          <h4>{t("plugins.center.title")}</h4>
          <p>{t("plugins.center.settingsHint")}</p>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={() => {
            closeSettings();
            navigateToFeature(PLUGINS_PATH, navigate);
          }}
        >
          {t("plugins.center.open")}
        </button>
      </div>
    </div>
  );
}
