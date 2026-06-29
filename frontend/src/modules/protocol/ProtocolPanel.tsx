import { useCallback, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { useI18n } from "../../i18n";
import { SidebarWorkspace } from "../../components/ui/SidebarWorkspace";
import { ModuleSegmentDock } from "../../components/dock";
import { ProtocolHttpWorkspace } from "./ProtocolHttpWorkspace";
import { MqttPanel } from "./MqttPanel";
import { SerialPanel } from "./SerialPanel";
import { GrpcPanel } from "./GrpcPanel";
import { SnifferPanel } from "./SnifferPanel";
import { ModbusPanel } from "./ModbusPanel";
import { ProtocolContextSidebar, type ProtocolKind } from "./ProtocolContextSidebar";
import { ProtocolHttpProvider } from "./ProtocolHttpContext";
const PROTOCOLS: ProtocolKind[] = ["http", "mqtt", "serial", "grpc", "sniffer", "modbus"];

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

    // HTTP 工作区自带 SidebarWorkspace + ProtocolHttpSidebar，避免与外层重复嵌套
    if (protocol === "http") {
      return (
        <ProtocolHttpProvider>
          <ProtocolHttpWorkspace />
        </ProtocolHttpProvider>
      );
    }

    return (
      <SidebarWorkspace
        layoutPersistKey="protocol"
        className="protocol-workspace"
        sidebar={<ProtocolContextSidebar protocol={protocol} />}
      >
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
      moduleTitle={t("routes.protocol")}
      tabs={segmentTabs}
      activeTabId={active}
      onActiveTabChange={(id) => setActive(id as ProtocolKind)}
      enabled={isActiveRoute}
      renderPanel={renderPanel}
    />
  );
}
