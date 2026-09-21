import { useMemo, useState } from "react";

import { useI18n } from "../../i18n";
import { WorkbenchActionButton } from "../../components/ui/primitives/WorkbenchActionButton";
import { SegmentedControl } from "../../components/ui/primitives/SegmentedControl";
import { OmniMcpToolsExposureSection } from "../../components/settings/OmniMcpToolsExposureSection";
import { OMNIMCP_BUILTIN_MCP_URL } from "../../lib/ai/localServicePorts";

type AgentSnippetId = "opencode" | "cursor" | "claudeCode" | "codex";

function buildAgentSnippets(url: string): { id: AgentSnippetId; language: "json" | "toml"; code: string }[] {
  return [
    {
      id: "opencode",
      language: "json",
      code: `{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "omnipanel": {
      "type": "remote",
      "url": "${url}",
      "enabled": true
    }
  }
}`,
    },
    {
      id: "cursor",
      language: "json",
      code: `{
  "mcpServers": {
    "omnipanel": {
      "url": "${url}"
    }
  }
}`,
    },
    {
      id: "claudeCode",
      language: "json",
      code: `{
  "mcpServers": {
    "omnipanel": {
      "type": "http",
      "url": "${url}"
    }
  }
}`,
    },
    {
      id: "codex",
      language: "toml",
      code: `[mcp_servers.omnipanel]
url = "${url}"
`,
    },
  ];
}

/** OmniPanel 对外只暴露一个 MCP Server（OmniMCP）。 */
export function AiGatewaySettings() {
  const { t } = useI18n();
  const url = useMemo(() => OMNIMCP_BUILTIN_MCP_URL, []);
  const snippets = useMemo(() => buildAgentSnippets(url), [url]);
  const [activeAgent, setActiveAgent] = useState<AgentSnippetId>("opencode");

  const agentOptions = useMemo(
    () =>
      snippets.map((snippet) => ({
        value: snippet.id,
        label: t(`settings.aiServices.omnimcp.agents.${snippet.id}.title`),
      })),
    [snippets, t],
  );

  const activeSnippet = useMemo(
    () => snippets.find((s) => s.id === activeAgent) ?? snippets[0]!,
    [snippets, activeAgent],
  );

  const copyText = async (text: string) => {
    await navigator.clipboard.writeText(text);
  };

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <div>
          <h2>{t("settings.aiServices.title")}</h2>
          <p className="section-desc">{t("settings.aiServices.desc")}</p>
        </div>
      </div>

      <div className="settings-subsection">
        <div className="settings-subsection-title">{t("settings.aiServices.omnimcp.toolsTitle")}</div>
        <p className="setting-hint settings-subsection-desc">
          {t("settings.aiServices.omnimcp.toolsDesc")}
        </p>
        <OmniMcpToolsExposureSection />
      </div>

      <div className="settings-section-divider" />

      <div className="settings-subsection">
        <div className="settings-subsection-title">{t("settings.aiServices.omnimcp.agentsConfigTitle")}</div>
        <p className="setting-hint settings-subsection-desc">
          {t("settings.aiServices.omnimcp.agentsConfigDesc", { url })}
        </p>
        <SegmentedControl
          options={agentOptions}
          value={activeAgent}
          onChange={setActiveAgent}
          ariaLabel={t("settings.aiServices.omnimcp.agentsConfigTitle")}
        />
        <p className="setting-hint settings-subsection-desc">
          {t(`settings.aiServices.omnimcp.agents.${activeSnippet.id}.hint`)}
        </p>
        <pre className="settings-code-block">{activeSnippet.code}</pre>
        <WorkbenchActionButton onClick={() => void copyText(activeSnippet.code)}>
          {activeSnippet.language === "toml"
            ? t("settings.aiServices.omnimcp.copyToml")
            : t("settings.aiServices.omnimcp.copyJson")}
        </WorkbenchActionButton>
      </div>
    </div>
  );
}
