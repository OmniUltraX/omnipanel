import { useState, useRef, useCallback } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
        use_tls: brokerUrl.startsWith("mqtts"),
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
  }, [status, brokerUrl, clientId]);

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
          placeholder="mqtt://broker.example.com:1883"
          value={brokerUrl}
          onChange={(e) => setBrokerUrl(e.target.value)}
          style={{ flex: 1 }}
          disabled={status === "connected"}
        />
        <input
          className="input"
          placeholder="Client ID"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          style={{ width: "140px" }}
          disabled={status === "connected"}
        />
        <button
          className={`btn ${status === "connected" ? "btn-danger" : "btn-primary"}`}
          onClick={handleConnect}
        >
          {status === "connected" ? "Disconnect" : status === "connecting" ? "..." : "Connect"}
        </button>
      </div>

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
            ? "Connecting..."
            : status === "connected"
              ? "Connected"
              : "Disconnected"}
        </span>
        {status === "connected" && (
          <span className="text-muted">Messages: {messages.length}</span>
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
          <span style={{ fontSize: "11px", fontWeight: 600 }}>Subscriptions</span>
          <input
            className="input"
            placeholder="Topic to subscribe..."
            value={newTopic}
            onChange={(e) => setNewTopic(e.target.value)}
            style={{ width: "240px", fontSize: "11px" }}
            disabled={status !== "connected"}
          />
          <select
            className="input"
            style={{ width: "60px", fontSize: "11px" }}
            value={newQos}
            onChange={(e) => setNewQos(Number(e.target.value) as MqttQos)}
          >
            <option value={0}>QoS 0</option>
            <option value={1}>QoS 1</option>
            <option value={2}>QoS 2</option>
          </select>
          <button
            className="btn btn-ghost btn-sm"
            onClick={handleSubscribe}
            disabled={status !== "connected"}
          >
            Subscribe
          </button>
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
            No messages received
          </div>
        ) : (
          messages.map((msg, i) => (
            <div className="mqtt-msg" key={i}>
              <span className="mqtt-topic-name">{msg.topic}</span>
              <span className="mqtt-payload">{msg.payload}</span>
              <span className="mqtt-meta">
                QoS {msg.qos}
                {msg.retain ? " · Retain" : ""} · {msg.time}
              </span>
            </div>
          ))
        )}
      </div>

      {/* Publish bar */}
      <div style={{ display: "flex", gap: "var(--sp-2)" }}>
        <input
          className="input"
          placeholder="Topic"
          value={pubTopic}
          onChange={(e) => setPubTopic(e.target.value)}
          style={{ width: "200px" }}
          disabled={status !== "connected"}
        />
        <select
          className="input"
          style={{ width: "70px" }}
          value={pubQos}
          onChange={(e) => setPubQos(Number(e.target.value) as MqttQos)}
        >
          <option value={0}>QoS 0</option>
          <option value={1}>QoS 1</option>
          <option value={2}>QoS 2</option>
        </select>
        <input
          className="input"
          placeholder='{"action":"reboot"}'
          value={pubPayload}
          onChange={(e) => setPubPayload(e.target.value)}
          style={{ flex: 1 }}
          disabled={status !== "connected"}
        />
        <button
          className="btn btn-primary btn-sm"
          onClick={handlePublish}
          disabled={status !== "connected"}
        >
          Publish
        </button>
      </div>
    </div>
  );
}
