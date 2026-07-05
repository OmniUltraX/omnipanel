import { useI18n } from "../../i18n";
import { WorkspaceEmptyPage } from "../../components/ui/workspace/WorkspaceEmptyPage";
import type { ProtocolTabKey } from "../../lib/protocolLabConfig";
import { GrpcPanel } from "./GrpcPanel";
import { ModbusPanel } from "./ModbusPanel";
import { MqttPanel } from "./MqttPanel";
import { MqttProvider } from "./MqttContext";
import { HttpPanel } from "./HttpPanel";
import { RedisPubSubPanel } from "./RedisPubSubPanel";
import { SerialPanel } from "./SerialPanel";
import { SnifferPanel } from "./SnifferPanel";

interface ProtocolHttpSessionPanelProps {
  resourceId: string | null;
  enabled: boolean;
}

function ProtocolHttpSessionPanel({ resourceId, enabled }: ProtocolHttpSessionPanelProps) {
  const { t } = useI18n();

  if (!enabled) {
    return <div className="http-panel http-panel--inactive" aria-hidden />;
  }

  if (!resourceId) {
    return (
      <WorkspaceEmptyPage
        title={t("protocol.tabs.http")}
        prompt={t("protocol.http.workspaceEmpty")}
      />
    );
  }

  return <HttpPanel />;
}

interface ProtocolSessionPanelProps {
  tabId: string;
  protocol: ProtocolTabKey;
  resourceId: string | null;
  enabled: boolean;
}

/** 协议实验室 Dock 会话面板：按协议渲染对应工作区。 */
export function ProtocolSessionPanel({
  tabId,
  protocol,
  resourceId,
  enabled,
}: ProtocolSessionPanelProps) {
  const { t } = useI18n();

  if (protocol === "http") {
    return <ProtocolHttpSessionPanel resourceId={resourceId} enabled={enabled} />;
  }

  if (protocol === "mqtt") {
    const panel = <MqttPanel />;
    if (!enabled) {
      return <div className="protocol-session-panel protocol-session-panel--inactive" aria-hidden />;
    }
    return <MqttProvider key={tabId}>{panel}</MqttProvider>;
  }

  if (!enabled) {
    return <div className="protocol-session-panel protocol-session-panel--inactive" aria-hidden />;
  }

  if (protocol === "pubsub") {
    return <RedisPubSubPanel />;
  }
  if (protocol === "serial") {
    return <SerialPanel />;
  }
  if (protocol === "grpc") {
    return <GrpcPanel />;
  }
  if (protocol === "sniffer") {
    return <SnifferPanel />;
  }
  if (protocol === "modbus") {
    return <ModbusPanel />;
  }

  return (
    <div className="protocol-workspace-tab-panel protocol-workspace-tab-panel--empty">
      {t("protocol.newTab.unsupported")}
    </div>
  );
}
