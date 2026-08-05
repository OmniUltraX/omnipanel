import { useI18n } from "../../i18n";
import type { ProtocolTabKey } from "../../lib/protocolLabConfig";
import { useProtocolWorkspaceStore } from "../../stores/protocolWorkspaceStore";
import { GrpcPanel } from "./GrpcPanel";
import { ModbusPanel } from "./ModbusPanel";
import { MqttPanel } from "./MqttPanel";
import { MqttProvider } from "./MqttContext";
import { HttpPanel } from "./HttpPanel";
import { RedisPubSubPanel } from "./RedisPubSubPanel";
import { SerialPanel } from "./SerialPanel";
import { SnifferPanel } from "./SnifferPanel";

interface ProtocolHttpSessionPanelProps {
  tabId: string;
  enabled: boolean;
}

function ProtocolHttpSessionPanel({ tabId, enabled }: ProtocolHttpSessionPanelProps) {
  const { t } = useI18n();
  // Dock 面板内容经 renderPanelRef 注入，props 不会随 bindTabResource 自动刷新；
  // 必须从 store 订阅 resourceId，否则新建 HTTP 请求会一直停在「加载中」。
  const resourceId = useProtocolWorkspaceStore(
    (s) => s.tabs.find((tab) => tab.id === tabId)?.resourceId ?? null,
  );

  if (!enabled) {
    return <div className="http-panel http-panel--inactive" aria-hidden />;
  }

  if (!resourceId) {
    return (
      <div className="http-panel http-panel--loading" role="status">
        {t("common.loading")}
      </div>
    );
  }

  return <HttpPanel />;
}

interface ProtocolSessionPanelProps {
  tabId: string;
  protocol: ProtocolTabKey;
  /** @deprecated HTTP 面板改从 workspace store 按 tabId 读取；保留以免调用方类型断裂 */
  resourceId?: string | null;
  enabled: boolean;
}

/** 协议实验室 Dock 会话面板：按协议渲染对应工作区。 */
export function ProtocolSessionPanel({
  tabId,
  protocol: protocolProp,
  enabled,
}: ProtocolSessionPanelProps) {
  const { t } = useI18n();
  // 预览槽可在同 tabId 上替换协议 / 资源；props 可能滞后，以 store 为准
  const protocol =
    useProtocolWorkspaceStore((s) => s.tabs.find((tab) => tab.id === tabId)?.protocol) ??
    protocolProp;

  if (protocol === "http") {
    return <ProtocolHttpSessionPanel tabId={tabId} enabled={enabled} />;
  }

  if (protocol === "mqtt") {
    const panel = <MqttPanel />;
    if (!enabled) {
      return <div className="protocol-session-panel protocol-session-panel--inactive" aria-hidden />;
    }
    return <MqttProvider key={`${tabId}:${protocol}`}>{panel}</MqttProvider>;
  }

  if (!enabled) {
    return <div className="protocol-session-panel protocol-session-panel--inactive" aria-hidden />;
  }

  if (protocol === "pubsub") {
    return <RedisPubSubPanel key={`${tabId}:${protocol}`} />;
  }
  if (protocol === "serial") {
    return <SerialPanel key={`${tabId}:${protocol}`} />;
  }
  if (protocol === "grpc") {
    return <GrpcPanel key={`${tabId}:${protocol}`} />;
  }
  if (protocol === "sniffer") {
    return <SnifferPanel key={`${tabId}:${protocol}`} />;
  }
  if (protocol === "modbus") {
    return <ModbusPanel key={`${tabId}:${protocol}`} />;
  }

  return (
    <div className="protocol-workspace-tab-panel protocol-workspace-tab-panel--empty">
      {t("protocol.newTab.unsupported")}
    </div>
  );
}
