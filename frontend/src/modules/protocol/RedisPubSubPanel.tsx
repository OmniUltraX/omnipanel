import { useState, useRef, useCallback, useEffect } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useI18n } from "../../i18n";
import { Button } from "../../components/ui/Button";
import { PasswordInput } from "../../components/ui/PasswordInput";
import { TextInput } from "../../components/ui/TextInput";

type PubSubStatus = "disconnected" | "connecting" | "connected";

interface PubSubMessage {
  direction: "in" | "out";
  channel: string;
  payload: string;
  time: string;
}

interface PubSubIpcMessage {
  channel: string;
  payload: string;
  timestamp: string;
}

export const REDIS_CHANNEL_PRESETS = [
  "notifications",
  "events:user:*",
  "cache:invalidate",
];

function nowTime(): string {
  const d = new Date();
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
}

export function RedisPubSubPanel() {
  const { t } = useI18n();
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("6379");
  const [database, setDatabase] = useState("0");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<PubSubStatus>("disconnected");
  const [connectError, setConnectError] = useState<string | null>(null);

  const [subscriptions, setSubscriptions] = useState<string[]>([]);
  const [newChannel, setNewChannel] = useState("");
  const [messages, setMessages] = useState<PubSubMessage[]>([]);

  const [pubChannel, setPubChannel] = useState("notifications");
  const [pubPayload, setPubPayload] = useState('{"event":"ping"}');

  const sessionIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  const subscriptionsRef = useRef(subscriptions);
  subscriptionsRef.current = subscriptions;
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const cleanupSession = useCallback(async () => {
    if (sessionIdRef.current) {
      try {
        await invoke("redis_pubsub_disconnect", { id: sessionIdRef.current });
      } catch {
        /* ignore */
      }
      sessionIdRef.current = null;
    }
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      void cleanupSession();
    };
  }, [cleanupSession]);

  const subscribeChannel = useCallback(async (channel: string) => {
    const trimmed = channel.trim();
    if (!trimmed || !sessionIdRef.current) return;
    if (subscriptionsRef.current.includes(trimmed)) return;

    await invoke("redis_pubsub_subscribe", {
      id: sessionIdRef.current,
      channel: trimmed,
    });
    setSubscriptions((prev) => [...prev, trimmed]);
  }, []);

  const handleConnect = useCallback(async () => {
    if (status === "connected" || status === "connecting") {
      await cleanupSession();
      setStatus("disconnected");
      setConnectError(null);
      return;
    }

    setStatus("connecting");
    setConnectError(null);
    try {
      const onMessage = new Channel<PubSubIpcMessage>();
      onMessage.onmessage = (msg: PubSubIpcMessage) => {
        setMessages((prev) => [
          ...prev,
          {
            direction: "in",
            channel: msg.channel,
            payload: msg.payload,
            time: msg.timestamp,
          },
        ]);
      };

      const config = {
        host,
        port: Number(port) || 6379,
        database: Math.min(15, Math.max(0, Number(database) || 0)),
        username: username.trim() || null,
        password: password || null,
      };

      const id = await invoke<string>("redis_pubsub_connect", { config, onMessage });
      sessionIdRef.current = id;

      const unlisten = await listen<{ session_id: string; event: string }>(
        "redis-pubsub-event",
        (event) => {
          if (event.payload.session_id === id) {
            setStatus("disconnected");
            sessionIdRef.current = null;
          }
        },
      );
      unlistenRef.current = unlisten;

      for (const channel of subscriptionsRef.current) {
        await invoke("redis_pubsub_subscribe", { id, channel });
      }

      setStatus("connected");
    } catch (e) {
      console.error("Redis Pub/Sub connect failed:", e);
      setStatus("disconnected");
      setConnectError(e instanceof Error ? e.message : String(e));
      await cleanupSession();
    }
  }, [status, host, port, database, username, password, cleanupSession]);

  const handleSubscribe = useCallback(async () => {
    try {
      await subscribeChannel(newChannel);
      setNewChannel("");
    } catch (e) {
      console.error("Redis subscribe failed:", e);
    }
  }, [newChannel, subscribeChannel]);

  const handleUnsubscribe = useCallback(async (idx: number) => {
    const channel = subscriptionsRef.current[idx];
    if (!channel || !sessionIdRef.current) return;
    try {
      await invoke("redis_pubsub_unsubscribe", {
        id: sessionIdRef.current,
        channel,
      });
      setSubscriptions((prev) => prev.filter((_, i) => i !== idx));
    } catch (e) {
      console.error("Redis unsubscribe failed:", e);
    }
  }, []);

  const handlePublish = useCallback(async () => {
    if (!sessionIdRef.current) return;
    try {
      await invoke("redis_pubsub_publish", {
        id: sessionIdRef.current,
        message: { channel: pubChannel, message: pubPayload },
      });
      setMessages((prev) => [
        ...prev,
        {
          direction: "out",
          channel: pubChannel,
          payload: pubPayload,
          time: nowTime(),
        },
      ]);
    } catch (e) {
      console.error("Redis publish failed:", e);
    }
  }, [pubChannel, pubPayload]);

  const connected = status === "connected";
  const locked = connected || status === "connecting";

  return (
    <div className="pubsub-panel proto-pub-panel">
      <div className="proto-pub-toolbar">
        <TextInput
          className="input"
          placeholder={t("protocol.pubsub.hostPlaceholder")}
          value={host}
          onChange={setHost}
          disabled={locked}
        />
        <TextInput
          className="input"
          placeholder={t("protocol.pubsub.portPlaceholder")}
          value={port}
          onChange={setPort}
          style={{ width: "80px" }}
          disabled={locked}
        />
        <TextInput
          className="input"
          placeholder={t("protocol.pubsub.databasePlaceholder")}
          value={database}
          onChange={setDatabase}
          style={{ width: "56px" }}
          disabled={locked}
        />
        <TextInput
          className="input"
          placeholder={t("protocol.pubsub.usernamePlaceholder")}
          value={username}
          onChange={setUsername}
          disabled={locked}
        />
        <PasswordInput
          placeholder={t("protocol.pubsub.passwordPlaceholder")}
          value={password}
          onChange={setPassword}
          disabled={locked}
        />
        <Button variant={connected ? "danger" : "primary"} onClick={() => void handleConnect()}>
          {connected
            ? t("protocol.common.disconnect")
            : status === "connecting"
              ? "…"
              : t("protocol.common.connect")}
        </Button>
      </div>

      <div className="proto-pub-status">
        <span className={`badge ${connected ? "badge-success" : "badge-muted"}`}>
          {status === "connecting"
            ? t("protocol.common.connecting")
            : connected
              ? t("protocol.common.connected")
              : t("protocol.common.disconnected")}
        </span>
        {connected && (
          <span className="text-muted">
            {t("protocol.common.messages", { count: messages.length })}
          </span>
        )}
        {connectError && <span className="proto-pub-error">{connectError}</span>}
        {messages.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setMessages([])}>
            {t("protocol.common.clearMessages")}
          </Button>
        )}
      </div>

      <div className="proto-pub-subscribe">
        <span className="proto-pub-section-label">{t("protocol.pubsub.subscriptions")}</span>
        <TextInput
          className="input"
          placeholder={t("protocol.pubsub.subscribeChannel")}
          value={newChannel}
          onChange={setNewChannel}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleSubscribe();
          }}
          disabled={!connected}
        />
        <Button variant="ghost" size="sm" onClick={() => void handleSubscribe()} disabled={!connected}>
          {t("protocol.pubsub.subscribe")}
        </Button>
      </div>

      <div className="mqtt-topics">
        {subscriptions.map((channel, i) => (
          <span className="mqtt-topic" key={channel}>
            {channel}
            <span className="topic-remove" onClick={() => void handleUnsubscribe(i)}>
              ×
            </span>
          </span>
        ))}
      </div>

      <div className="mqtt-messages">
        {messages.length === 0 ? (
          <div className="proto-pub-empty">{t("protocol.pubsub.noMessages")}</div>
        ) : (
          messages.map((msg, i) => (
            <div
              className={`mqtt-msg ${msg.direction === "out" ? "mqtt-msg--out" : "mqtt-msg--in"}`}
              key={`${msg.time}-${i}`}
            >
              <span className="mqtt-direction">{msg.direction === "out" ? "↑" : "↓"}</span>
              <span className="mqtt-topic-name">{msg.channel}</span>
              <span className="mqtt-payload">{msg.payload}</span>
              <span className="mqtt-meta">{msg.time}</span>
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="proto-pub-publish">
        <TextInput
          className="input"
          placeholder={t("protocol.pubsub.channel")}
          value={pubChannel}
          onChange={setPubChannel}
          disabled={!connected}
        />
        <TextInput
          className="input"
          placeholder={t("protocol.pubsub.publishPayload")}
          value={pubPayload}
          onChange={setPubPayload}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handlePublish();
          }}
          disabled={!connected}
        />
        <Button variant="primary" size="sm" onClick={() => void handlePublish()} disabled={!connected}>
          {t("protocol.pubsub.publish")}
        </Button>
      </div>
    </div>
  );
}
