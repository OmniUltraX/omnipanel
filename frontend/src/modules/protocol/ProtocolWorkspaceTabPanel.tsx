import { useI18n } from "../../i18n";
import type { ProtocolTabKey } from "../../lib/protocolLabConfig";
import { GrpcPanel } from "./GrpcPanel";
import { ModbusPanel } from "./ModbusPanel";
import { MqttPanel } from "./MqttPanel";
import { MqttProvider } from "./MqttContext";
import { ProtocolHttpProvider } from "./ProtocolHttpContext";
import { HttpRequestPanel } from "./HttpRequestPanel";
import { RedisPubSubPanel } from "./RedisPubSubPanel";
import { SerialPanel } from "./SerialPanel";
import { SnifferPanel } from "./SnifferPanel";

interface ProtocolWorkspaceTabPanelProps {
  tabId: string;
  protocol: ProtocolTabKey;
  enabled: boolean;
  /** 外层 ProtocolPanel 已包裹 MqttProvider 时跳过 */
  omitMqttProvider?: boolean;
  /** 外层 ProtocolPanel 已包裹 ProtocolHttpProvider 时跳过 */
  omitHttpProvider?: boolean;
}

export function ProtocolWorkspaceTabPanel({
  tabId,
  protocol,
  enabled,
  omitMqttProvider = false,
  omitHttpProvider = false,
}: ProtocolWorkspaceTabPanelProps) {
  const { t } = useI18n();

  if (protocol === "http") {
    const panel = <HttpRequestPanel enabled={enabled} windowControl={false} />;
    if (omitHttpProvider) {
      return panel;
    }
    return <ProtocolHttpProvider>{panel}</ProtocolHttpProvider>;
  }

  if (protocol === "mqtt") {
    const panel = <MqttPanel />;
    if (omitMqttProvider) {
      return panel;
    }
    return (
      <MqttProvider key={tabId}>
        {panel}
      </MqttProvider>
    );
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
