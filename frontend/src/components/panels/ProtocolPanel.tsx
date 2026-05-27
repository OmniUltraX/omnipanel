import { useState } from "react";
import { HttpPanel, WsPanel, MqttPanel, SerialPanel } from "./protocol";

type Protocol = "http" | "ws" | "mqtt" | "serial";

interface HistoryItem {
  protocol: Protocol;
  method?: string;
  url: string;
  status: string;
  time: string;
}

const PROTOCOLS: { id: Protocol; label: string; icon: string }[] = [
  {
    id: "http",
    label: "HTTP / REST",
    icon: "M22 12h-4l-3 9L9 3l-3 9H2",
  },
  {
    id: "ws",
    label: "WebSocket",
    icon: "M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10zM2 12h20",
  },
  {
    id: "mqtt",
    label: "MQTT",
    icon: "M3 3v18h18M18 17V9M13 17V5M8 17v-3",
  },
  {
    id: "serial",
    label: "Serial",
    icon: "M2 6h20v12H2zM6 12h.01M10 12h.01M14 12h.01",
  },
];

const HISTORY: HistoryItem[] = [
  { protocol: "http", method: "GET", url: "/api/users", status: "200 · 12ms", time: "1" },
  { protocol: "http", method: "POST", url: "/api/auth/login", status: "200 · 89ms", time: "2" },
  { protocol: "http", method: "GET", url: "/api/products?page=1", status: "200 · 45ms", time: "3" },
  { protocol: "http", method: "PUT", url: "/api/users/123", status: "204 · 23ms", time: "4" },
  { protocol: "http", method: "DELETE", url: "/api/sessions/expired", status: "200 · 67ms", time: "5" },
];

export function ProtocolPanel() {
  const [activeProtocol, setActiveProtocol] = useState<Protocol>("http");

  const renderPanel = () => {
    switch (activeProtocol) {
      case "http":
        return <HttpPanel />;
      case "ws":
        return <WsPanel />;
      case "mqtt":
        return <MqttPanel />;
      case "serial":
        return <SerialPanel />;
    }
  };

  return (
    <div className="proto-workspace">
      {/* Protocol Navigation */}
      <div className="proto-sidebar">
        <div className="proto-section-title">Protocol</div>
        {PROTOCOLS.map((proto) => (
          <div
            key={proto.id}
            className={`proto-nav-item${activeProtocol === proto.id ? " active" : ""}`}
            onClick={() => setActiveProtocol(proto.id)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d={proto.icon} />
            </svg>
            {proto.label}
          </div>
        ))}

        <div className="proto-section-title" style={{ marginTop: "var(--sp-4)" }}>
          History
        </div>
        {HISTORY.map((item, i) => (
          <div className="history-item" key={i}>
            {item.method && (
              <span className={`h-method method-${item.method.toLowerCase()}`}>
                {item.method === "DELETE" ? "DEL" : item.method}
              </span>
            )}
            <span className="h-url">{item.url}</span>
            <span className="h-time">{item.status}</span>
          </div>
        ))}
      </div>

      {/* Main Content */}
      <div className="proto-main">
        <div className="proto-content">{renderPanel()}</div>
      </div>
    </div>
  );
}
