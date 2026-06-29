import type { ReactNode } from "react";
import { useI18n } from "../../i18n";
import { Button } from "../../components/ui/Button";
import {
  VerticalSplitSidebar,
  VerticalSplitSidebarSection,
  usePersistedVerticalSplitSections,
} from "../../components/ui/VerticalSplitSidebar";
import { ProtocolHttpSidebar } from "./ProtocolHttpSidebar";

export type ProtocolKind = "http" | "mqtt" | "serial" | "grpc" | "sniffer" | "modbus";

const MQTT_TOPICS = [
  { topic: "/devices/+/telemetry", qos: "1" },
  { topic: "/alerts/#", qos: "0" },
  { topic: "home/sensors/temp", qos: "1" },
];

const SERIAL_PORTS = [
  { port: "COM3", desc: "USB-SERIAL CH340", baud: "115200" },
  { port: "COM5", desc: "Arduino Uno", baud: "9600" },
];

const SNIFFER_FILTERS = [
  { label: "All Traffic", filter: "" },
  { label: "HTTP (tcp/80)", filter: "tcp port 80" },
  { label: "HTTPS (tcp/443)", filter: "tcp port 443" },
  { label: "DNS (udp/53)", filter: "udp port 53" },
  { label: "SSH (tcp/22)", filter: "tcp port 22" },
  { label: "ICMP Only", filter: "icmp" },
];

interface Props {
  protocol: ProtocolKind;
}

function ProtocolGenericSidebar({
  storageKey,
  sections,
  children,
}: {
  storageKey: string;
  sections: Record<string, { title: string; defaultExpanded: boolean; content: ReactNode }>;
  children?: ReactNode;
}) {
  const defaults = Object.fromEntries(
    Object.entries(sections).map(([key, value]) => [key, value.defaultExpanded]),
  ) as Record<string, boolean>;
  const { sections: expanded, toggleSection } = usePersistedVerticalSplitSections(storageKey, defaults);

  return (
    <aside className="proto-sidebar proto-sidebar--tree">
      <VerticalSplitSidebar className="proto-sidebar-sections">
        {Object.entries(sections).map(([key, section]) => (
          <VerticalSplitSidebarSection
            key={key}
            title={section.title}
            expanded={expanded[key]}
            onToggle={() => toggleSection(key)}
          >
            {section.content}
          </VerticalSplitSidebarSection>
        ))}
        {children}
      </VerticalSplitSidebar>
    </aside>
  );
}

export function ProtocolContextSidebar({ protocol }: Props) {
  const { t } = useI18n();

  if (protocol === "http") {
    return <ProtocolHttpSidebar />;
  }

  if (protocol === "mqtt") {
    return (
      <ProtocolGenericSidebar
        storageKey="omnipanel-protocol-mqtt-sidebar.v1"
        sections={{
          topics: {
            title: t("protocol.sidebar.topics"),
            defaultExpanded: true,
            content: (
              <>
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
              </>
            ),
          },
        }}
      />
    );
  }

  if (protocol === "sniffer") {
    return (
      <ProtocolGenericSidebar
        storageKey="omnipanel-protocol-sniffer-sidebar.v1"
        sections={{
          filters: {
            title: t("protocol.sniffer.captureFilters"),
            defaultExpanded: true,
            content: SNIFFER_FILTERS.map((item) => (
              <button key={item.filter} type="button" className="proto-context-item">
                <span className="proto-context-body">
                  <span className="proto-context-title">{item.label}</span>
                  <span className="proto-context-meta">{item.filter || "(no filter)"}</span>
                </span>
              </button>
            )),
          },
        }}
      />
    );
  }

  return (
    <ProtocolGenericSidebar
      storageKey={`omnipanel-protocol-${protocol}-sidebar.v1`}
      sections={{
        ports: {
          title: t("protocol.sidebar.ports"),
          defaultExpanded: true,
          content: SERIAL_PORTS.map((item) => (
            <button key={item.port} type="button" className="proto-context-item">
              <span className="proto-context-body">
                <span className="proto-context-title">{item.port}</span>
                <span className="proto-context-meta">
                  {item.desc} · {item.baud}
                </span>
              </span>
            </button>
          )),
        },
      }}
    />
  );
}
