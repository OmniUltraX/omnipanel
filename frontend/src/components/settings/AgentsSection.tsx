import { useCallback, useEffect, useMemo, useState } from "react";

import { useI18n } from "../../i18n";
import { connectAgentByKind } from "../../lib/agents/connect";
import { statusByKind } from "../../lib/agents/detect";
import { AGENT_ADAPTERS, getAgentAdapter } from "../../lib/agents/registry";
import type { AgentKind } from "../../lib/agents/types";
import { formatLaunchCommand } from "../../lib/agents/types";
import { getAcpStatus } from "../../lib/acp/acpStream";
import { syncAndReconnectActiveAcpAgent } from "../../lib/acp/syncAgentConfig";
import {
  getActiveAgentKind,
  resolveAcpModelSelectionId,
  useAcpServicesStore,
} from "../../stores/acpServicesStore";
import { isTauriRuntime } from "../../lib/isTauriRuntime";
import { McpServicesSection } from "./McpServicesSection";
import { Button } from "../ui/Button";

export function AgentsSection() {
  const { t } = useI18n();
  const services = useAcpServicesStore((s) => s.services);
  const installStatuses = useAcpServicesStore((s) => s.installStatuses);
  const detecting = useAcpServicesStore((s) => s.detecting);
  const setActive = useAcpServicesStore((s) => s.setActive);
  const refreshDetection = useAcpServicesStore((s) => s.refreshDetection);

  const [connected, setConnected] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [connecting, setConnecting] = useState(false);

  const activeKind = getActiveAgentKind(services);

  const refreshStatus = useCallback(async () => {
    if (!isTauriRuntime()) {
      setConnected(false);
      setStatusText(t("settings.acpServices.connection.browserMode"));
      return;
    }
    try {
      const status = await getAcpStatus();
      setConnected(status.connected);
      if (status.connected) {
        setStatusText(
          status.agentName
            ? t("settings.acpServices.connection.connectedWithName", { name: status.agentName })
            : t("settings.acpServices.connection.connected"),
        );
      } else {
        setStatusText(t("settings.acpServices.connection.disconnected"));
      }
    } catch {
      setConnected(false);
      setStatusText(t("settings.acpServices.connection.disconnected"));
    }
  }, [t]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus, services, activeKind]);

  const handleConnect = useCallback(async () => {
    if (!isTauriRuntime()) return;
    setConnecting(true);
    try {
      const installStatus = statusByKind(installStatuses, activeKind);
      if (!installStatus?.installed) {
        throw new Error(t("settings.agents.notInstalled", { name: t(getAgentAdapter(activeKind).nameKey) }));
      }
      const adapter = getAgentAdapter(activeKind);
      const modelSelectionId = adapter.requiresOmniPanelConfig()
        ? resolveAcpModelSelectionId(services.find((s) => s.isActive) ?? null)
        : null;
      if (adapter.requiresOmniPanelConfig() && !modelSelectionId) {
        throw new Error(t("settings.acpServices.connection.modelRequired"));
      }
      await connectAgentByKind(activeKind, installStatus, modelSelectionId);
      await refreshStatus();
    } catch (error) {
      setConnected(false);
      setStatusText(error instanceof Error ? error.message : String(error));
    } finally {
      setConnecting(false);
    }
  }, [activeKind, installStatuses, refreshStatus, services, t]);

  const handleSelectAgent = useCallback(
    (kind: AgentKind) => {
      setActive(kind);
      void syncAndReconnectActiveAcpAgent().catch(() => {});
    },
    [setActive],
  );

  const statusClassName = useMemo(() => {
    if (connected) return "opencode-detect-status opencode-detect-status--installed";
    if (statusText && !connecting) {
      return "opencode-detect-status opencode-detect-status--missing";
    }
    return "opencode-detect-status";
  }, [connected, statusText, connecting]);

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <div>
          <h2>{t("settings.agents.title")}</h2>
          <p className="section-desc">{t("settings.agents.description")}</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={detecting || !isTauriRuntime()}
          onClick={() => void refreshDetection()}
        >
          {detecting ? t("settings.agents.detecting") : t("settings.agents.redetect")}
        </Button>
      </div>

      <div className={statusClassName}>
        <span
          className={`opencode-detect-status__text${connected ? "" : " opencode-detect-status__text--error"}`}
        >
          {statusText || t("settings.acpServices.connection.disconnected")}
        </span>
        <Button
          variant="secondary"
          size="sm"
          disabled={connecting || !isTauriRuntime()}
          onClick={() => void handleConnect()}
        >
          {connecting
            ? t("settings.acpServices.connection.connecting")
            : t("settings.acpServices.connection.connect")}
        </Button>
      </div>

      <ul className="ai-models-list">
        {AGENT_ADAPTERS.map((adapter) => {
          const status = statusByKind(installStatuses, adapter.kind);
          const isActive = adapter.kind === activeKind;
          const launchCommand = status ? formatLaunchCommand(status) : null;
          const isBuiltin = adapter.kind === "omniagent";

          return (
            <li
              key={adapter.kind}
              className={`ai-provider-card${isActive ? " ai-provider-card--active" : ""}${isBuiltin ? " ai-provider-card--builtin" : ""}`}
            >
              <div className="ai-provider-header">
                <div className="ai-provider-header-main">
                  <span className="ai-provider-expand-placeholder" aria-hidden />
                  <div className="ai-provider-summary">
                    <div className="ai-provider-title-row">
                      <span className="ai-provider-name">{t(adapter.nameKey)}</span>
                      {isBuiltin ? (
                        <span className="ai-model-row-standard ai-model-row-standard-active">
                          {t("settings.acpServices.builtinBadge")}
                        </span>
                      ) : null}
                      <span
                        className={`ai-model-row-standard ${
                          status?.installed
                            ? "ai-model-row-standard-active"
                            : "ai-model-row-standard-openai"
                        }`}
                      >
                        {status?.installed
                          ? t("settings.agents.installed")
                          : t("settings.agents.notFound")}
                      </span>
                      {isActive ? (
                        <span className="ai-model-row-standard ai-model-row-standard-active">
                          {t("settings.acpServices.activeBadge")}
                        </span>
                      ) : null}
                    </div>
                    <div className="ai-model-row-meta">
                      <span className="ai-model-row-baseurl" title={launchCommand ?? undefined}>
                        {launchCommand ?? t("settings.agents.installHint")}
                      </span>
                      {status?.version ? (
                        <>
                          <span className="ai-model-row-sep">·</span>
                          <span className="ai-model-row-key">{status.version}</span>
                        </>
                      ) : null}
                    </div>
                    <p className="section-desc" style={{ marginTop: 4 }}>
                      {t(adapter.descriptionKey)}
                    </p>
                  </div>
                </div>

                <div className="ai-model-row-actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    className={`ai-model-row-activate${isActive ? " is-active" : ""}`}
                    disabled={!status?.installed}
                    onClick={() => handleSelectAgent(adapter.kind)}
                    title={
                      isActive
                        ? t("settings.acpServices.activeTitle")
                        : t("settings.acpServices.activateTitle")
                    }
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
                      <path d="M12 2v10" />
                      <path d="M5.6 5.6a9 9 0 1012.8 0" />
                    </svg>
                  </Button>
                </div>
              </div>

              {isActive ? (
                <div className="ai-provider-agent-mcp">
                  <McpServicesSection embedded />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
