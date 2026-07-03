import { useMemo, useState } from "react";

import { useI18n } from "../../i18n";
import { useSettingsStore } from "../../stores/settingsStore";
import { Button } from "../../components/ui/Button";
import { TextInput } from "../../components/ui/TextInput";
import { PasswordInput } from "../../components/ui/PasswordInput";
import { TraceListView } from "./TraceListView";
import { OmniMcpToolsExposureSection } from "../../components/settings/OmniMcpToolsExposureSection";
import { McpServiceToolList } from "../../components/settings/McpServiceToolList";
import { OMNIMCP_BUILTIN_SERVICE_ID } from "../../lib/ai/context/moduleMcpCatalog";

type Tab = "router" | "omnimcp" | "traces";

const MCP_CURSOR_SNIPPET = `{
  "mcpServers": {
    "omnipanel": {
      "url": "http://127.0.0.1:12756/mcp"
    }
  }
}`;

function SettingToggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      className={`toggle ${value ? "on" : ""}`}
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      style={{ cursor: "pointer" }}
    />
  );
}

export function AiGatewaySettings() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("router");
  const aiGatewayEnabled = useSettingsStore((s) => s.aiGatewayEnabled);
  const aiGatewayPort = useSettingsStore((s) => s.aiGatewayPort);
  const aiGatewayApiKey = useSettingsStore((s) => s.aiGatewayApiKey);
  const aiGatewayBindLan = useSettingsStore((s) => s.aiGatewayBindLan);
  const mcpExternalRequireApproval = useSettingsStore((s) => s.mcpExternalRequireApproval);
  const setAiGatewaySettings = useSettingsStore((s) => s.setAiGatewaySettings);

  const curlExample = useMemo(() => {
    const port = aiGatewayPort || 8765;
    const auth = aiGatewayApiKey.trim()
      ? `-H "Authorization: Bearer ${aiGatewayApiKey.trim()}" `
      : "";
    return `curl ${auth}-H "Content-Type: application/json" -H "X-Conversation-Id: demo" \\
  http://127.0.0.1:${port}/v1/chat/completions \\
  -d '{"model":"http:provider_1::gpt-4o-mini","stream":true,"messages":[{"role":"user","content":"hello"}]}'`;
  }, [aiGatewayPort, aiGatewayApiKey]);

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

      <div className="settings-tabs" role="tablist">
        {(
          [
            ["router", t("settings.aiServices.tabRouter")],
            ["omnimcp", t("settings.aiServices.tabOmniMcp")],
            ["traces", t("settings.aiServices.tabTraces")],
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

      {tab === "router" ? (
        <div className="settings-subsection">
          <div className="setting-row">
            <div className="setting-label">
              <h4>{t("settings.aiServices.router.enabled")}</h4>
              <p>{t("settings.aiServices.router.enabledDesc")}</p>
            </div>
            <SettingToggle
              value={aiGatewayEnabled}
              onChange={(v) => setAiGatewaySettings({ aiGatewayEnabled: v })}
            />
          </div>
          <div className="setting-row">
            <div className="setting-label">
              <h4>{t("settings.aiServices.router.port")}</h4>
            </div>
            <div className="setting-control setting-control--narrow">
              <TextInput
                type="number"
                size="sm"
                value={String(aiGatewayPort)}
                onChange={(v) =>
                  setAiGatewaySettings({ aiGatewayPort: Number(v) || 8765 })
                }
              />
            </div>
          </div>
          <div className="setting-row">
            <div className="setting-label">
              <h4>{t("settings.aiServices.router.apiKey")}</h4>
            </div>
            <div className="setting-control setting-control--wide">
              <PasswordInput
                size="sm"
                value={aiGatewayApiKey}
                onChange={(v) => setAiGatewaySettings({ aiGatewayApiKey: v })}
                placeholder={t("settings.aiServices.router.apiKeyPlaceholder")}
              />
            </div>
          </div>
          <div className="setting-row">
            <div className="setting-label">
              <h4>{t("settings.aiServices.router.bindLan")}</h4>
              <p>{t("settings.aiServices.router.bindLanDesc")}</p>
            </div>
            <SettingToggle
              value={aiGatewayBindLan}
              onChange={(v) => setAiGatewaySettings({ aiGatewayBindLan: v })}
            />
          </div>

          <div className="settings-section-divider" />

          <div className="settings-subsection-title">{t("settings.aiServices.router.curlTitle")}</div>
          <pre className="settings-code-block">{curlExample}</pre>
          <Button variant="secondary" size="sm" onClick={() => void copyText(curlExample)}>
            {t("settings.aiServices.router.copyCurl")}
          </Button>
        </div>
      ) : null}

      {tab === "omnimcp" ? (
        <div className="settings-subsection">
          <p className="setting-hint settings-subsection-desc">
            {t("settings.aiServices.omnimcp.desc", { url: "http://127.0.0.1:12756/mcp" })}
          </p>
          <div className="setting-row">
            <div className="setting-label">
              <h4>{t("settings.aiServices.omnimcp.requireApproval")}</h4>
              <p>{t("settings.aiServices.omnimcp.requireApprovalDesc")}</p>
            </div>
            <SettingToggle
              value={mcpExternalRequireApproval}
              onChange={(v) => setAiGatewaySettings({ mcpExternalRequireApproval: v })}
            />
          </div>

          <div className="settings-section-divider" />

          <div className="settings-subsection-title">{t("settings.aiServices.omnimcp.toolsTitle")}</div>
          <p className="setting-hint settings-subsection-desc">
            {t("settings.aiServices.omnimcp.toolsDesc")}
          </p>
          <OmniMcpToolsExposureSection />

          <div className="settings-section-divider" />

          <div className="settings-subsection-title">{t("settings.aiServices.omnimcp.liveToolsTitle")}</div>
          <p className="setting-hint settings-subsection-desc">
            {t("settings.aiServices.omnimcp.liveToolsDesc")}
          </p>
          <McpServiceToolList serviceId={OMNIMCP_BUILTIN_SERVICE_ID} />

          <div className="settings-section-divider" />

          <div className="settings-subsection-title">{t("settings.aiServices.omnimcp.cursorTitle")}</div>
          <pre className="settings-code-block">{MCP_CURSOR_SNIPPET}</pre>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void copyText(MCP_CURSOR_SNIPPET)}
          >
            {t("settings.aiServices.omnimcp.copyJson")}
          </Button>
        </div>
      ) : null}

      {tab === "traces" ? <TraceListView /> : null}
    </div>
  );
}
