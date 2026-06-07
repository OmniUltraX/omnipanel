import { useMemo, useState } from "react";
import { useTopbarTabs } from "../../hooks/useTopbarTabs";
import { useI18n } from "../../i18n";
import { HttpPanel } from "./HttpPanel";
import { WsPanel } from "./WsPanel";
import { MqttPanel } from "./MqttPanel";
import { SerialPanel } from "./SerialPanel";
import { GrpcPanel } from "./GrpcPanel";
import { ProtocolContextSidebar, type ProtocolKind } from "./ProtocolContextSidebar";

const PROTOCOLS: ProtocolKind[] = ["http", "ws", "mqtt", "serial", "grpc"];

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
    }
  };

  return (
    <div className="proto-workspace">
      <ProtocolContextSidebar protocol={active} />
      <div className="proto-main">
        <div className="proto-content">{renderPanel()}</div>
      </div>
    </div>
  );
}
