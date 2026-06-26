import { useI18n } from "../../i18n";

function AgentOpenCodeSection() {
  const { t } = useI18n();

  return (
    <div className="settings-section">
      <h2>{t("settings.agent.opencode.title")}</h2>
      <p className="section-desc">{t("settings.agent.opencode.description")}</p>
      <p className="settings-agent-placeholder">{t("settings.agent.comingSoon")}</p>
    </div>
  );
}

function AgentCursorSection() {
  const { t } = useI18n();

  return (
    <div className="settings-section">
      <h2>{t("settings.agent.cursor.title")}</h2>
      <p className="section-desc">{t("settings.agent.cursor.description")}</p>
      <p className="settings-agent-placeholder">
        {t("settings.agent.comingSoon")}
      </p>
    </div>
  );
}

export function AgentSection() {
  return (
    <div className="settings-panel active">
      <AgentOpenCodeSection />
      <div className="settings-section-divider" />
      <AgentCursorSection />
    </div>
  );
}
