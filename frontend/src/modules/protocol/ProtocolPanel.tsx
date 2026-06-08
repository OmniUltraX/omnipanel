import { useMemo, useState } from "react";
import { useTopbarTabs } from "../../hooks/useTopbarTabs";
import { useI18n } from "../../i18n";
import { SidebarWorkspace } from "../../components/ui/SidebarWorkspace";
import { HttpPanel } from "./HttpPanel";
import { WsPanel } from "./WsPanel";
import { MqttPanel } from "./MqttPanel";
import { SerialPanel } from "./SerialPanel";
import { GrpcPanel } from "./GrpcPanel";
import { SnifferPanel } from "./SnifferPanel";
import { ModbusPanel } from "./ModbusPanel";
import { ProtocolContextSidebar, type ProtocolKind } from "./ProtocolContextSidebar";

const PROTOCOLS: ProtocolKind[] = ["http", "ws", "mqtt", "serial", "grpc", "sniffer", "modbus"];

export function ProtocolPanel() {
  const { t } = useI18n();
  const [active, setActive] = useState<ProtocolKind>("http");

  const topbarTabs = useMemo(
    () =>
      PROTOCOLS.map((id) => ({
        id,
        label: t(`protocol.tabs.${id}`),
        active: active === id,
      })),
    [active, t]
  );

  useTopbarTabs(topbarTabs, {
    onSelect: (id) => setActive(id as ProtocolKind),
  }, { mode: "segment" });

  const renderPanel = () => {
    switch (active) {
      case "http":
        return <HttpPanel />;
      case "ws":
        return <WsPanel />;
      case "mqtt":
        return <MqttPanel />;
      case "serial":
        return <SerialPanel />;
      case "grpc":
        return <GrpcPanel />;
      case "sniffer":
        return <SnifferPanel />;
      case "modbus":
        return <ModbusPanel />;
    }
  };

  return (
    <SidebarWorkspace sidebar={<ProtocolContextSidebar protocol={active} />}>
      {renderPanel()}
    </SidebarWorkspace>
  );
}
