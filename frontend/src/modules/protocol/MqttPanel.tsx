import { useRef, useEffect } from "react";
import { useI18n } from "../../i18n";
import { Button } from "../../components/ui/Button";
import { PasswordInput } from "../../components/ui/PasswordInput";
import { TextInput } from "../../components/ui/TextInput";
import { Select } from "../../components/ui/Select";
import { useMqtt, type MqttQos } from "./MqttContext";

const QOS_OPTIONS = [
  { value: "0", label: "QoS 0" },
  { value: "1", label: "QoS 1" },
  { value: "2", label: "QoS 2" },
];

export function MqttPanel() {
  const { t } = useI18n();
  const mqtt = useMqtt();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [mqtt.messages.length]);

  const connected = mqtt.status === "connected";
  const locked = connected || mqtt.status === "connecting";

  return (
    <div className="mqtt-panel proto-pub-panel">
      <div className="proto-pub-toolbar">
        <TextInput
          className="url-input"
          placeholder={t("protocol.mqtt.brokerPlaceholder")}
          value={mqtt.brokerUrl}
          onChange={mqtt.setBrokerUrl}
          disabled={locked}
        />
        <TextInput
          className="input"
          placeholder={t("protocol.mqtt.clientId")}
          value={mqtt.clientId}
          onChange={mqtt.setClientId}
          disabled={locked}
        />
        <TextInput
          className="input"
          placeholder={t("protocol.mqtt.username")}
          value={mqtt.username}
          onChange={mqtt.setUsername}
          disabled={locked}
        />
        <PasswordInput
          placeholder={t("protocol.mqtt.password")}
          value={mqtt.password}
          onChange={(value) => mqtt.setPassword(value)}
          disabled={locked}
        />
        <Button
          variant={connected ? "danger" : "primary"}
          onClick={() => void mqtt.toggleConnection()}
        >
          {connected
            ? t("protocol.common.disconnect")
            : mqtt.status === "connecting"
              ? "…"
              : t("protocol.common.connect")}
        </Button>
      </div>

      <div className="proto-pub-options">
        <label className="proto-pub-option">
          <input
            type="checkbox"
            checked={mqtt.showTls}
            onChange={() => mqtt.setShowTls(!mqtt.showTls)}
            disabled={locked}
          />
          TLS
        </label>
        <label className="proto-pub-option">
          <input
            type="checkbox"
            checked={mqtt.showWill}
            onChange={() => mqtt.setShowWill(!mqtt.showWill)}
            disabled={locked}
          />
          {t("protocol.mqtt.willMessage")}
        </label>
      </div>

      {mqtt.showTls && (
        <div className="proto-pub-advanced">
          <label className="proto-pub-option">
            <input
              type="checkbox"
              checked={mqtt.useTls}
              onChange={(e) => mqtt.setUseTls(e.target.checked)}
              disabled={locked}
            />
            {t("protocol.mqtt.enableTls")}
          </label>
          <TextInput
            className="input"
            placeholder={t("protocol.mqtt.tlsCaPath")}
            value={mqtt.tlsCaPath}
            onChange={mqtt.setTlsCaPath}
            disabled={locked}
          />
          <TextInput
            className="input"
            placeholder={t("protocol.mqtt.tlsClientCert")}
            value={mqtt.tlsClientCert}
            onChange={mqtt.setTlsClientCert}
            disabled={locked}
          />
          <TextInput
            className="input"
            placeholder={t("protocol.mqtt.tlsClientKey")}
            value={mqtt.tlsClientKey}
            onChange={mqtt.setTlsClientKey}
            disabled={locked}
          />
        </div>
      )}

      {mqtt.showWill && (
        <div className="proto-pub-advanced">
          <TextInput
            className="input"
            placeholder={t("protocol.mqtt.willTopicPlaceholder")}
            value={mqtt.willTopic}
            onChange={mqtt.setWillTopic}
            disabled={locked}
          />
          <TextInput
            className="input"
            placeholder={t("protocol.mqtt.willPayloadPlaceholder")}
            value={mqtt.willPayload}
            onChange={mqtt.setWillPayload}
            disabled={locked}
          />
          <Select
            className="input"
            size="sm"
            style={{ width: "70px" }}
            value={String(mqtt.willQos)}
            onChange={(v) => mqtt.setWillQos(Number(v) as MqttQos)}
            disabled={locked}
            searchable={false}
            options={QOS_OPTIONS}
          />
          <label className="proto-pub-option">
            <input
              type="checkbox"
              checked={mqtt.willRetain}
              onChange={(e) => mqtt.setWillRetain(e.target.checked)}
              disabled={locked}
            />
            {t("protocol.common.retain")}
          </label>
        </div>
      )}

      <div className="proto-pub-status">
        <span className={`badge ${connected ? "badge-success" : "badge-muted"}`}>
          {mqtt.status === "connecting"
            ? t("protocol.common.connecting")
            : connected
              ? t("protocol.common.connected")
              : t("protocol.common.disconnected")}
        </span>
        {connected && (
          <span className="text-muted">
            {t("protocol.common.messages", { count: mqtt.messages.length })}
          </span>
        )}
        {mqtt.connectError && (
          <span className="proto-pub-error">{mqtt.connectError}</span>
        )}
        {mqtt.messages.length > 0 && (
          <Button variant="ghost" size="sm" onClick={mqtt.clearMessages}>
            {t("protocol.common.clearMessages")}
          </Button>
        )}
      </div>

      <div className="proto-pub-subscribe">
        <span className="proto-pub-section-label">{t("protocol.mqtt.subscriptions")}</span>
        <TextInput
          className="input"
          placeholder={t("protocol.mqtt.subscribeTopic")}
          value={mqtt.newTopic}
          onChange={mqtt.setNewTopic}
          onKeyDown={(e) => {
            if (e.key === "Enter") void mqtt.subscribe();
          }}
          disabled={!connected}
        />
        <Select
          className="input"
          size="sm"
          style={{ width: "60px" }}
          value={String(mqtt.newQos)}
          onChange={(v) => mqtt.setNewQos(Number(v) as MqttQos)}
          searchable={false}
          options={QOS_OPTIONS}
        />
        <Button variant="ghost" size="sm" onClick={() => void mqtt.subscribe()} disabled={!connected}>
          {t("protocol.mqtt.subscribe")}
        </Button>
      </div>

      <div className="mqtt-topics">
        {mqtt.subscriptions.map((sub, i) => (
          <span className="mqtt-topic" key={sub.topic}>
            {sub.topic}
            <span className="topic-qos">QoS {sub.qos}</span>
            <span className="topic-remove" onClick={() => void mqtt.unsubscribe(i)}>
              ×
            </span>
          </span>
        ))}
      </div>

      <div className="mqtt-messages">
        {mqtt.messages.length === 0 ? (
          <div className="proto-pub-empty">{t("protocol.mqtt.noMessages")}</div>
        ) : (
          mqtt.messages.map((msg, i) => (
            <div
              className={`mqtt-msg ${msg.direction === "out" ? "mqtt-msg--out" : "mqtt-msg--in"}`}
              key={`${msg.time}-${i}`}
            >
              <span className="mqtt-direction">
                {msg.direction === "out" ? "↑" : "↓"}
              </span>
              <span className="mqtt-topic-name">{msg.topic}</span>
              <span className="mqtt-payload">{msg.payload}</span>
              <span className="mqtt-meta">
                QoS {msg.qos}
                {msg.retain ? ` · ${t("protocol.common.retain")}` : ""} · {msg.time}
              </span>
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="proto-pub-publish">
        <TextInput
          className="input"
          placeholder={t("protocol.mqtt.topic")}
          value={mqtt.pubTopic}
          onChange={mqtt.setPubTopic}
          disabled={!connected}
        />
        <Select
          className="input"
          size="sm"
          style={{ width: "70px" }}
          value={String(mqtt.pubQos)}
          onChange={(v) => mqtt.setPubQos(Number(v) as MqttQos)}
          searchable={false}
          options={QOS_OPTIONS}
        />
        <label className="proto-pub-option proto-pub-option--inline">
          <input
            type="checkbox"
            checked={mqtt.pubRetain}
            onChange={(e) => mqtt.setPubRetain(e.target.checked)}
            disabled={!connected}
          />
          {t("protocol.common.retain")}
        </label>
        <TextInput
          className="input"
          placeholder={t("protocol.mqtt.publishPayload")}
          value={mqtt.pubPayload}
          onChange={mqtt.setPubPayload}
          onKeyDown={(e) => {
            if (e.key === "Enter") void mqtt.publish();
          }}
          disabled={!connected}
        />
        <Button variant="primary" size="sm" onClick={() => void mqtt.publish()} disabled={!connected}>
          {t("protocol.mqtt.publish")}
        </Button>
      </div>
    </div>
  );
}
