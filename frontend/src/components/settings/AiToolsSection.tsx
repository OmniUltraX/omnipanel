import { useState } from "react";

import { useI18n } from "../../i18n";
import { McpServicesSection } from "./McpServicesSection";
import { BuiltinToolsSettingsSection } from "./BuiltinToolsSettingsSection";
import { WebSearchSettingsSection } from "./WebSearchSettingsSection";
import { SkillsSection } from "./SkillsSection";

type AiToolsTab = "builtin" | "externalMcp" | "skills";

export function AiToolsSection() {
  const { t } = useI18n();
  const [tab, setTab] = useState<AiToolsTab>("builtin");

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <div>
          <h2>{t("settings.aiTools.title")}</h2>
          <p className="section-desc">{t("settings.aiTools.desc")}</p>
        </div>
      </div>

      <div className="settings-tabs" role="tablist">
        {(
          [
            ["builtin", t("settings.aiTools.tabBuiltin")],
            ["externalMcp", t("settings.aiTools.tabExternalMcp")],
            ["skills", t("settings.aiTools.tabSkills")],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`settings-tab${tab === id ? " is-active" : ""}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "builtin" ? (
        <div className="settings-subsection">
          <div className="settings-subsection-card">
            <p className="setting-hint settings-subsection-desc">{t("settings.builtinTools.desc")}</p>
            <BuiltinToolsSettingsSection />
            <WebSearchSettingsSection />
          </div>
        </div>
      ) : null}

      {tab === "externalMcp" ? (
        <div className="settings-subsection">
          <p className="setting-hint settings-subsection-desc">{t("settings.mcpServices.description")}</p>
          <McpServicesSection contentOnly externalOnly />
        </div>
      ) : null}

      {tab === "skills" ? <SkillsSection /> : null}
    </div>
  );
}
