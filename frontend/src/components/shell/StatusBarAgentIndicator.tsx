import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import {
  connectActiveAgent,
  disconnectActiveAgent,
  queryAgentConnectionSnapshot,
} from "../../lib/acp/agentConnection";
import { getAgentAdapter } from "../../lib/agents/registry";
import { useAcpServicesStore, getActiveAgentKind } from "../../stores/acpServicesStore";
import { isTauriRuntime } from "../../lib/isTauriRuntime";

const STATUS_POLL_MS = 5000;

export function StatusBarAgentIndicator() {
  const { t } = useI18n();
  const services = useAcpServicesStore((s) => s.services);
  const activeKind = useMemo(() => getActiveAgentKind(services), [services]);
  const agentLabel = t(getAgentAdapter(activeKind).nameKey);

  const [connected, setConnected] = useState(false);
  const [remoteAgentName, setRemoteAgentName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    if (!isTauriRuntime()) {
      setConnected(false);
      setRemoteAgentName(null);
      return;
    }
    const snapshot = await queryAgentConnectionSnapshot();
    if (!snapshot) {
      setConnected(false);
      setRemoteAgentName(null);
      return;
    }
    setConnected(snapshot.connected);
    setRemoteAgentName(snapshot.agentName);
  }, []);

  useEffect(() => {
    void refreshStatus();
    if (!isTauriRuntime()) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshStatus();
    }, STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refreshStatus, activeKind]);

  const handleToggle = useCallback(async () => {
    if (!isTauriRuntime() || busy) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      if (connected) {
        await disconnectActiveAgent();
        setConnected(false);
        setRemoteAgentName(null);
      } else {
        await connectActiveAgent({
          notInstalled: (nameKey) =>
            t("settings.agents.notInstalled", { name: t(nameKey) }),
          modelRequired: t("settings.acpServices.connection.modelRequired"),
          notLaunchable: t("shell.statusbar.agent.notLaunchable"),
        });
        await refreshStatus();
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      setConnected(false);
    } finally {
      setBusy(false);
    }
  }, [busy, connected, refreshStatus, t]);

  if (!isTauriRuntime()) {
    return (
      <span
        className="statusbar-item statusbar-agent statusbar-agent--disabled"
        title={t("settings.acpServices.connection.browserMode")}
      >
        <span className="statusbar-dot" aria-hidden />
        <span className="statusbar-agent__name">{agentLabel}</span>
        <span className="statusbar-agent__status">{t("shell.statusbar.agent.browserMode")}</span>
      </span>
    );
  }

  const statusLabel = busy
    ? t("settings.acpServices.connection.connecting")
    : connected
      ? remoteAgentName
        ? t("shell.statusbar.agent.connectedNamed", { name: remoteAgentName })
        : t("shell.statusbar.agent.connected")
      : error ?? t("shell.statusbar.agent.disconnected");

  const dotClass = busy
    ? "yellow"
    : connected
      ? "green"
      : error
        ? "red"
        : "";

  const title = connected
    ? t("shell.statusbar.agent.clickToDisconnect", { agent: agentLabel })
    : t("shell.statusbar.agent.clickToConnect", { agent: agentLabel });

  return (
    <button
      type="button"
      className={`statusbar-item statusbar-button statusbar-agent${
        connected ? " statusbar-agent--connected" : ""
      }${busy ? " statusbar-agent--busy" : ""}${error ? " statusbar-agent--error" : ""}`}
      disabled={busy}
      title={title}
      aria-label={title}
      aria-pressed={connected}
      onClick={() => void handleToggle()}
    >
      <span className={`statusbar-dot${dotClass ? ` ${dotClass}` : ""}`} aria-hidden />
      <span className="statusbar-agent__name">{agentLabel}</span>
      <span className="statusbar-agent__status">{statusLabel}</span>
    </button>
  );
}
