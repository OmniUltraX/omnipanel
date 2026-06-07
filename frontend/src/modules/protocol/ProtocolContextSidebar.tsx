import { useI18n } from "../../i18n";

export type ProtocolKind = "http" | "ws" | "mqtt" | "serial" | "grpc";

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

export function ProtocolContextSidebar({ protocol }: Props) {
  const { t } = useI18n();

  if (protocol === "http") {
    return (
      <aside className="proto-sidebar">
        <div className="proto-section-title">{t("protocol.sidebar.history")}</div>
        {HTTP_HISTORY.map((item) => (
          <div key={`${item.method}-${item.url}`} className="history-item">
            <span className={`h-method ${methodClass(item.method)}`}>
              {item.method === "DELETE" ? "DEL" : item.method}
            </span>
            <span className="h-url">{item.url}</span>
            <span className="h-time">
              {item.status} · {item.time}
            </span>
          </div>
        ))}
      </aside>
    );
  }

  if (protocol === "ws") {
    return (
      <aside className="proto-sidebar">
        <div className="proto-section-title">{t("protocol.sidebar.endpoints")}</div>
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
        <div className="proto-section-title">{t("protocol.sidebar.topics")}</div>
        <div className="proto-sidebar-tags">
          {MQTT_TOPICS.map((item) => (
            <span key={item.topic} className="mqtt-topic">
              {item.topic}
              <span className="topic-qos">QoS {item.qos}</span>
            </span>
          ))}
        </div>
        <button type="button" className="btn btn-ghost btn-sm proto-sidebar-action">
          {t("protocol.sidebar.addTopic")}
        </button>
      </aside>
    );
  }

  return (
    <aside className="proto-sidebar">
      <div className="proto-section-title">{t("protocol.sidebar.ports")}</div>
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
