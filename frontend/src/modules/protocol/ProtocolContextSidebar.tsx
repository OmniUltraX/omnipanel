import type { ReactNode } from "react";
import { useI18n } from "../../i18n";
import {
  VerticalSplitSidebar,
  VerticalSplitSidebarSection,
  usePersistedVerticalSplitSections,
} from "../../components/ui/VerticalSplitSidebar";
import { ProtocolHttpSidebar } from "./ProtocolHttpSidebar";
import { ProtocolSidebarNewButton } from "./ProtocolSidebarNewButton";
import { MQTT_TOPIC_PRESETS, useMqtt } from "./MqttContext";
import { REDIS_CHANNEL_PRESETS } from "./RedisPubSubPanel";
import type { ProtocolTabKey } from "../../lib/protocolLabConfig";

export type ProtocolKind = ProtocolTabKey;

const SNIFFER_FILTERS = [
  { label: "All Traffic", filter: "" },
  { label: "HTTP (tcp/80)", filter: "tcp port 80" },
  { label: "HTTPS (tcp/443)", filter: "tcp port 443" },
  { label: "DNS (udp/53)", filter: "udp port 53" },
  { label: "SSH (tcp/22)", filter: "tcp port 22" },
  { label: "ICMP Only", filter: "icmp" },
];

const SERIAL_PORTS = [
  { port: "COM3", desc: "USB-SERIAL CH340", baud: "115200" },
  { port: "COM5", desc: "Arduino Uno", baud: "9600" },
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
  const sectionEntries = Object.entries(sections);

  return (
    <aside className="proto-sidebar proto-sidebar--tree">
      <VerticalSplitSidebar className="proto-sidebar-sections">
        {sectionEntries.map(([key, section], index) => (
          <VerticalSplitSidebarSection
            key={key}
            title={section.title}
            expanded={expanded[key]}
            onToggle={() => toggleSection(key)}
            actions={index === 0 ? <ProtocolSidebarNewButton /> : undefined}
          >
            {section.content}
          </VerticalSplitSidebarSection>
        ))}
        {children}
      </VerticalSplitSidebar>
    </aside>
  );
}

function MqttSidebarContent() {
  const { t } = useI18n();
  const mqtt = useMqtt();
  const connected = mqtt.status === "connected";

  return (
    <>
      <div className="proto-sidebar-tags">
        {mqtt.subscriptions.map((sub) => (
          <span key={sub.topic} className="mqtt-topic">
            {sub.topic}
            <span className="topic-qos">QoS {sub.qos}</span>
          </span>
        ))}
        {mqtt.subscriptions.length === 0 && (
          <span className="proto-sidebar-empty">{t("protocol.mqtt.noSubscriptions")}</span>
        )}
      </div>
      <div className="proto-sidebar-presets">
        <span className="proto-sidebar-presets-label">{t("protocol.sidebar.topicPresets")}</span>
        {MQTT_TOPIC_PRESETS.map((item) => (
          <button
            key={item.topic}
            type="button"
            className="proto-context-item"
            onClick={() => {
              mqtt.fillSubscribeTopic(item.topic);
              if (connected) void mqtt.quickSubscribe(item.topic, item.qos);
            }}
          >
            <span className="proto-context-body">
              <span className="proto-context-title">{item.topic}</span>
              <span className="proto-context-meta">QoS {item.qos}</span>
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

function PubSubSidebarContent() {
  const { t } = useI18n();

  return (
    <div className="proto-sidebar-presets">
      <span className="proto-sidebar-presets-label">{t("protocol.sidebar.channelPresets")}</span>
      {REDIS_CHANNEL_PRESETS.map((channel) => (
        <button key={channel} type="button" className="proto-context-item">
          <span className="proto-context-body">
            <span className="proto-context-title">{channel}</span>
          </span>
        </button>
      ))}
      <p className="proto-sidebar-hint">{t("protocol.pubsub.sidebarHint")}</p>
    </div>
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
            content: <MqttSidebarContent />,
          },
        }}
      />
    );
  }

  if (protocol === "pubsub") {
    return (
      <ProtocolGenericSidebar
        storageKey="omnipanel-protocol-pubsub-sidebar.v1"
        sections={{
          channels: {
            title: t("protocol.sidebar.channels"),
            defaultExpanded: true,
            content: <PubSubSidebarContent />,
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
