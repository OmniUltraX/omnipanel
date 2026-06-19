import { useCallback, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { useI18n } from "../../i18n";
import { SidebarWorkspace } from "../../components/ui/SidebarWorkspace";
import { ModuleSegmentDock } from "../../components/dock";
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
  const location = useLocation();
  const isActiveRoute = location.pathname === "/module/protocol";
  const [active, setActive] = useState<ProtocolKind>("http");

  const segmentTabs = useMemo(
    () =>
      PROTOCOLS.map((id) => ({
        id,
        label: t(`protocol.tabs.${id}`),
      })),
    [t],
  );

  const renderPanel = useCallback((tabId: string) => {
    const protocol = tabId as ProtocolKind;
    return (
      <SidebarWorkspace sidebar={<ProtocolContextSidebar protocol={protocol} />}>
        {protocol === "http" && <HttpPanel />}
        {protocol === "ws" && <WsPanel />}
        {protocol === "mqtt" && <MqttPanel />}
        {protocol === "serial" && <SerialPanel />}
        {protocol === "grpc" && <GrpcPanel />}
        {protocol === "sniffer" && <SnifferPanel />}
        {protocol === "modbus" && <ModbusPanel />}
      </SidebarWorkspace>
    );
  }, []);

  return (
    <ModuleSegmentDock
      className="protocol-module-dock"
      tabs={segmentTabs}
      activeTabId={active}
      onActiveTabChange={(id) => setActive(id as ProtocolKind)}
      enabled={isActiveRoute}
      renderPanel={renderPanel}
    />
  );
}
