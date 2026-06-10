import { useI18n } from "../../i18n";
import { Button } from "../../components/ui/Button";

export type ProtocolKind = "http" | "ws" | "mqtt" | "serial" | "grpc" | "sniffer" | "modbus";

const HTTP_HISTORY = [
  { method: "GET", url: "/api/users", status: "200", time: "12ms" },
  { method: "POST", url: "/api/auth/login", status: "200", time: "89ms" },
  { method: "GET", url: "/api/products?page=1", status: "200", time: "45ms" },
  { method: "PUT", url: "/api/users/123", status: "204", time: "23ms" },
  { method: "DELETE", url: "/api/sessions/expired", status: "200", time: "67ms" },
];

const WS_SESSIONS = [
  { name: "dev-local", url: "ws://localhost:8080/ws", status: "online" },
  { name: "staging", url: "wss://staging-api/ws", status: "online" },
  { name: "mqtt-bridge", url: "ws://broker.local:9001", status: "offline" },
];

const MQTT_TOPICS = [
  { topic: "/devices/+/telemetry", qos: "1" },
  { topic: "/alerts/#", qos: "0" },
  { topic: "home/sensors/temp", qos: "1" },
];

const SERIAL_PORTS = [
  { port: "COM3", desc: "USB-SERIAL CH340", baud: "115200" },
  { port: "COM5", desc: "Arduino Uno", baud: "9600" },
];

function methodClass(method: string) {
  if (method === "GET") return "method-get";
  if (method === "POST") return "method-post";
  if (method === "PUT") return "method-put";
  return "method-delete";
}

interface Props {
  protocol: ProtocolKind;
}

/** 带标题行 + 新建按钮的侧栏头部 */
function SidebarHeader({ title, onNew }: { title: string; onNew?: () => void }) {
  return (
    <div className="proto-sidebar-header">
      <span className="proto-sidebar-title">{title}</span>
      {onNew && (
        <button type="button" className="proto-sidebar-new" onClick={onNew} title="新建">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14">
            <line x1="8" y1="3" x2="8" y2="13" />
            <line x1="3" y1="8" x2="13" y2="8" />
          </svg>
        </button>
      )}
    </div>
  );
}

export function ProtocolContextSidebar({ protocol }: Props) {
  const { t } = useI18n();

  if (protocol === "http") {
    return (
      <aside className="proto-sidebar">
        <SidebarHeader title={t("protocol.sidebar.history")} onNew={() => {}} />
        {HTTP_HISTORY.map((item) => (
          <div key={`${item.method}-${item.url}`} className="history-item">
            <div className="history-item-main">
              <span className={`h-method ${methodClass(item.method)}`}>
                {item.method === "DELETE" ? "DEL" : item.method}
              </span>
              <span className="h-url">{item.url}</span>
            </div>
            <div className="history-item-meta">
              <span className={`h-status ${Number(item.status) < 400 ? "h-status-ok" : "h-status-err"}`}>{item.status}</span>
              <span className="h-time">{item.time}</span>
            </div>
          </div>
        ))}
      </aside>
    );
  }

  if (protocol === "ws") {
    return (
      <aside className="proto-sidebar">
        <SidebarHeader title={t("protocol.sidebar.endpoints")} onNew={() => {}} />
        {WS_SESSIONS.map((session) => (
          <button key={session.name} type="button" className="proto-context-item">
            <span className={`status-dot ${session.status === "online" ? "online" : "offline"}`} />
            <span className="proto-context-body">
              <span className="proto-context-title">{session.name}</span>
              <span className="proto-context-meta">{session.url}</span>
            </span>
          </button>
        ))}
      </aside>
    );
  }

  if (protocol === "mqtt") {
    return (
      <aside className="proto-sidebar">
        <SidebarHeader title={t("protocol.sidebar.topics")} onNew={() => {}} />
        <div className="proto-sidebar-tags">
          {MQTT_TOPICS.map((item) => (
            <span key={item.topic} className="mqtt-topic">
              {item.topic}
              <span className="topic-qos">QoS {item.qos}</span>
            </span>
          ))}
        </div>
        <Button variant="ghost" size="sm" className="proto-sidebar-action">
          {t("protocol.sidebar.addTopic")}
        </Button>
      </aside>
    );
  }

  if (protocol === "sniffer") {
    return (
      <aside className="proto-sidebar">
        <SidebarHeader title="Capture Filters" />
        {[
          { label: "All Traffic", filter: "" },
          { label: "HTTP (tcp/80)", filter: "tcp port 80" },
          { label: "HTTPS (tcp/443)", filter: "tcp port 443" },
          { label: "DNS (udp/53)", filter: "udp port 53" },
          { label: "SSH (tcp/22)", filter: "tcp port 22" },
          { label: "ICMP Only", filter: "icmp" },
        ].map((item) => (
          <button key={item.filter} type="button" className="proto-context-item">
            <span className="proto-context-body">
              <span className="proto-context-title">{item.label}</span>
              <span className="proto-context-meta">
                {item.filter || "(no filter)"}
              </span>
            </span>
          </button>
        ))}
      </aside>
    );
  }

  return (
    <aside className="proto-sidebar">
      <SidebarHeader title={t("protocol.sidebar.ports")} onNew={() => {}} />
      {SERIAL_PORTS.map((item) => (
        <button key={item.port} type="button" className="proto-context-item">
          <span className="proto-context-body">
            <span className="proto-context-title">{item.port}</span>
            <span className="proto-context-meta">
              {item.desc} · {item.baud}
            </span>
          </span>
        </button>
      ))}
    </aside>
  );
}
