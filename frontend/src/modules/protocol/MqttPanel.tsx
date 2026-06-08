import { useState, useRef, useCallback } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useI18n } from "../../i18n";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Select";

type MqttQos = 0 | 1 | 2;
type MqttStatus = "disconnected" | "connecting" | "connected";

interface MqttMessage {
  topic: string;
  payload: string;
  qos: MqttQos;
  retain: boolean;
  time: string;
}

interface MqttSubscription {
  topic: string;
  qos: MqttQos;
}

interface MqttIpcMessage {
  topic: string;
  payload: string;
  qos: number;
  retain: boolean;
  timestamp: string;
}

export function MqttPanel() {
  const { t } = useI18n();
  const [brokerUrl, setBrokerUrl] = useState("mqtt://broker.hivemq.com:1883");
  const [clientId, setClientId] = useState("omnipanel-001");
  const [status, setStatus] = useState<MqttStatus>("disconnected");

  const [subscriptions, setSubscriptions] = useState<MqttSubscription[]>([]);
  const [newTopic, setNewTopic] = useState("");
  const [newQos, setNewQos] = useState<MqttQos>(0);

  const [messages, setMessages] = useState<MqttMessage[]>([]);

  const [pubTopic, setPubTopic] = useState("devices/esp32-01/cmd");
  const [pubQos, setPubQos] = useState<MqttQos>(0);
  const [pubPayload, setPubPayload] = useState('{"action":"reboot"}');

  // TLS state
  const [useTls, setUseTls] = useState(false);
  const [tlsCaPath, setTlsCaPath] = useState("");
  const [tlsClientCert, setTlsClientCert] = useState("");
  const [tlsClientKey, setTlsClientKey] = useState("");

  // Will Message state
  const [willTopic, setWillTopic] = useState("");
  const [willPayload, setWillPayload] = useState("");
  const [willQos, setWillQos] = useState<MqttQos>(0);
  const [willRetain, setWillRetain] = useState(false);

  // Collapsible sections
  const [showTls, setShowTls] = useState(false);
  const [showWill, setShowWill] = useState(false);

  const sessionIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  const handleConnect = useCallback(async () => {
    if (status === "connected") {
      // Disconnect
      if (sessionIdRef.current) {
        try {
          await invoke("mqtt_disconnect", { id: sessionIdRef.current });
        } catch { /* ignore */ }
        sessionIdRef.current = null;
      }
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
      setStatus("disconnected");
      return;
    }

    setStatus("connecting");
    try {
      const onMessage = new Channel<MqttIpcMessage>();
      onMessage.onmessage = (msg: MqttIpcMessage) => {
        setMessages((prev) => [
          ...prev,
          {
            topic: msg.topic,
            payload: msg.payload,
            qos: msg.qos as MqttQos,
            retain: msg.retain,
            time: msg.timestamp,
          },
        ]);
      };

      const config = {
        broker_url: brokerUrl,
        client_id: clientId,
        username: null,
        password: null,
        keep_alive_secs: 60,
        clean_session: true,
        use_tls: useTls || brokerUrl.startsWith("mqtts"),
        tls_ca_path: tlsCaPath || null,
        tls_client_cert: tlsClientCert || null,
        tls_client_key: tlsClientKey || null,
        will_topic: willTopic || null,
        will_payload: willPayload || null,
        will_qos: willTopic ? willQos : null,
        will_retain: willTopic ? willRetain : null,
      };

      const id = await invoke<string>("mqtt_connect", { config, onMessage });
      sessionIdRef.current = id;

      // Listen for disconnect events
      const unlisten = await listen<{ session_id: string; event: string }>(
        "mqtt-event",
        (event) => {
          if (event.payload.session_id === id) {
            setStatus("disconnected");
            sessionIdRef.current = null;
          }
        }
      );
      unlistenRef.current = unlisten;

      setStatus("connected");
    } catch (e) {
      console.error("MQTT connect failed:", e);
      setStatus("disconnected");
    }
  }, [status, brokerUrl, clientId, useTls, tlsCaPath, tlsClientCert, tlsClientKey, willTopic, willPayload, willQos, willRetain]);

  const handleSubscribe = useCallback(async () => {
    if (!newTopic.trim() || !sessionIdRef.current) return;
    try {
      await invoke("mqtt_subscribe", {
        id: sessionIdRef.current,
        subscription: { topic: newTopic, qos: newQos },
      });
      setSubscriptions((prev) => [...prev, { topic: newTopic, qos: newQos }]);
      setNewTopic("");
    } catch (e) {
      console.error("MQTT subscribe failed:", e);
    }
  }, [newTopic, newQos]);

  const handleUnsubscribe = useCallback(
    async (idx: number) => {
      const sub = subscriptions[idx];
      if (!sub || !sessionIdRef.current) return;
      try {
        await invoke("mqtt_unsubscribe", { id: sessionIdRef.current, topic: sub.topic });
        setSubscriptions((prev) => prev.filter((_, i) => i !== idx));
      } catch (e) {
        console.error("MQTT unsubscribe failed:", e);
      }
    },
    [subscriptions]
  );

  const handlePublish = useCallback(async () => {
    if (!sessionIdRef.current) return;
    try {
      await invoke("mqtt_publish", {
        id: sessionIdRef.current,
        message: { topic: pubTopic, payload: pubPayload, qos: pubQos, retain: false },
      });
    } catch (e) {
      console.error("MQTT publish failed:", e);
    }
  }, [pubTopic, pubPayload, pubQos]);

  return (
    <div className="mqtt-panel">
      {/* Connection bar */}
      <div style={{ display: "flex", gap: "var(--sp-2)", marginBottom: "var(--sp-4)" }}>
        <input
          className="url-input"
          placeholder={t("protocol.mqtt.brokerPlaceholder")}
          value={brokerUrl}
          onChange={(e) => setBrokerUrl(e.target.value)}
          style={{ flex: 1 }}
          disabled={status === "connected"}
        />
        <input
          className="input"
          placeholder={t("protocol.mqtt.clientId")}
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          style={{ width: "140px" }}
          disabled={status === "connected"}
        />
        <Button
          variant={status === "connected" ? "danger" : "primary"}
          onClick={handleConnect}
        >
          {status === "connected"
            ? t("protocol.common.disconnect")
            : status === "connecting"
              ? "…"
              : t("protocol.common.connect")}
        </Button>
      </div>

      {/* TLS & Will toggle row */}
      <div
        style={{
          display: "flex",
          gap: "var(--sp-3)",
          marginBottom: "var(--sp-2)",
          fontSize: "11px",
        }}
      >
        <label style={{ display: "flex", alignItems: "center", gap: "var(--sp-1)", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={showTls}
            onChange={() => setShowTls(!showTls)}
            disabled={status === "connected"}
          />
          TLS
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: "var(--sp-1)", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={showWill}
            onChange={() => setShowWill(!showWill)}
            disabled={status === "connected"}
          />
          Will Message
        </label>
      </div>

      {/* TLS Configuration */}
      {showTls && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--sp-2)",
            marginBottom: "var(--sp-3)",
            padding: "var(--sp-2)",
            background: "var(--bg-secondary)",
            borderRadius: "var(--radius)",
            fontSize: "11px",
          }}
        >
          <label style={{ display: "flex", alignItems: "center", gap: "var(--sp-1)" }}>
            <input
              type="checkbox"
              checked={useTls}
              onChange={(e) => setUseTls(e.target.checked)}
              disabled={status === "connected"}
            />
            Enable TLS
          </label>
          <input
            className="input"
            placeholder="CA certificate path"
            value={tlsCaPath}
            onChange={(e) => setTlsCaPath(e.target.value)}
            style={{ flex: "1 1 200px", fontSize: "11px" }}
            disabled={status === "connected"}
          />
          <input
            className="input"
            placeholder="Client certificate path"
            value={tlsClientCert}
            onChange={(e) => setTlsClientCert(e.target.value)}
            style={{ flex: "1 1 200px", fontSize: "11px" }}
            disabled={status === "connected"}
          />
          <input
            className="input"
            placeholder="Client private key path"
            value={tlsClientKey}
            onChange={(e) => setTlsClientKey(e.target.value)}
            style={{ flex: "1 1 200px", fontSize: "11px" }}
            disabled={status === "connected"}
          />
        </div>
      )}

      {/* Will Message Configuration */}
      {showWill && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--sp-2)",
            marginBottom: "var(--sp-3)",
            padding: "var(--sp-2)",
            background: "var(--bg-secondary)",
            borderRadius: "var(--radius)",
            fontSize: "11px",
          }}
        >
          <input
            className="input"
            placeholder="Will topic (e.g. status/client)"
            value={willTopic}
            onChange={(e) => setWillTopic(e.target.value)}
            style={{ flex: "1 1 180px", fontSize: "11px" }}
            disabled={status === "connected"}
          />
          <input
            className="input"
            placeholder="Will payload"
            value={willPayload}
            onChange={(e) => setWillPayload(e.target.value)}
            style={{ flex: "1 1 180px", fontSize: "11px" }}
            disabled={status === "connected"}
          />
          <Select
            className="input"
            size="sm"
            style={{ width: "70px" }}
            value={String(willQos)}
            onChange={(v) => setWillQos(Number(v) as MqttQos)}
            disabled={status === "connected"}
            searchable={false}
            options={[
              { value: "0", label: "QoS 0" },
              { value: "1", label: "QoS 1" },
              { value: "2", label: "QoS 2" },
            ]}
          />
          <label style={{ display: "flex", alignItems: "center", gap: "var(--sp-1)" }}>
            <input
              type="checkbox"
              checked={willRetain}
              onChange={(e) => setWillRetain(e.target.checked)}
              disabled={status === "connected"}
            />
            Retain
          </label>
        </div>
      )}

      {/* Status bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sp-3)",
          marginBottom: "var(--sp-3)",
          fontSize: "11px",
        }}
      >
        <span className={`badge ${status === "connected" ? "badge-success" : "badge-muted"}`}>
          {status === "connecting"
            ? t("protocol.common.connecting")
            : status === "connected"
              ? t("protocol.common.connected")
              : t("protocol.common.disconnected")}
        </span>
        {status === "connected" && (
          <span className="text-muted">{t("protocol.common.messages", { count: messages.length })}</span>
        )}
      </div>

      {/* Subscriptions */}
      <div style={{ marginBottom: "var(--sp-3)" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--sp-2)",
            marginBottom: "var(--sp-2)",
          }}
        >
          <span style={{ fontSize: "11px", fontWeight: 600 }}>{t("protocol.mqtt.subscriptions")}</span>
          <input
            className="input"
            placeholder={t("protocol.mqtt.subscribeTopic")}
            value={newTopic}
            onChange={(e) => setNewTopic(e.target.value)}
            style={{ width: "240px", fontSize: "11px" }}
            disabled={status !== "connected"}
          />
          <Select
            className="input"
            size="sm"
            style={{ width: "60px" }}
            value={String(newQos)}
            onChange={(v) => setNewQos(Number(v) as MqttQos)}
            searchable={false}
            options={[
              { value: "0", label: "QoS 0" },
              { value: "1", label: "QoS 1" },
              { value: "2", label: "QoS 2" },
            ]}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSubscribe}
            disabled={status !== "connected"}
          >
            {t("protocol.mqtt.subscribe")}
          </Button>
        </div>
        <div className="mqtt-topics">
          {subscriptions.map((sub, i) => (
            <span className="mqtt-topic" key={i}>
              {sub.topic}{" "}
              <span className="topic-remove" onClick={() => handleUnsubscribe(i)}>
                {"×"}
              </span>
            </span>
          ))}
        </div>
      </div>

      {/* Messages */}
      <div className="mqtt-messages">
        {messages.length === 0 ? (
          <div style={{ color: "var(--text-muted)", fontStyle: "italic", padding: "var(--sp-4)" }}>
            {t("protocol.mqtt.noMessages")}
          </div>
        ) : (
          messages.map((msg, i) => (
            <div className="mqtt-msg" key={i}>
              <span className="mqtt-topic-name">{msg.topic}</span>
              <span className="mqtt-payload">{msg.payload}</span>
              <span className="mqtt-meta">
                QoS {msg.qos}
                {msg.retain ? ` · ${t("protocol.common.retain")}` : ""} · {msg.time}
              </span>
            </div>
          ))
        )}
      </div>

      {/* Publish bar */}
      <div style={{ display: "flex", gap: "var(--sp-2)" }}>
        <input
          className="input"
          placeholder={t("protocol.mqtt.topic")}
          value={pubTopic}
          onChange={(e) => setPubTopic(e.target.value)}
          style={{ width: "200px" }}
          disabled={status !== "connected"}
        />
        <Select
          className="input"
          size="sm"
          style={{ width: "70px" }}
          value={String(pubQos)}
          onChange={(v) => setPubQos(Number(v) as MqttQos)}
          searchable={false}
          options={[
            { value: "0", label: "QoS 0" },
            { value: "1", label: "QoS 1" },
            { value: "2", label: "QoS 2" },
          ]}
        />
        <input
          className="input"
          placeholder={t("protocol.mqtt.publishPayload")}
          value={pubPayload}
          onChange={(e) => setPubPayload(e.target.value)}
          style={{ flex: 1 }}
          disabled={status !== "connected"}
        />
        <Button
          variant="primary"
          size="sm"
          onClick={handlePublish}
          disabled={status !== "connected"}
        >
          {t("protocol.mqtt.publish")}
        </Button>
      </div>
    </div>
  );
}
