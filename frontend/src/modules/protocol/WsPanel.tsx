import { useState, useRef, useCallback } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useI18n } from "../../i18n";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Select";

type WsStatus = "disconnected" | "connecting" | "connected";
type WsMsgFormat = "JSON" | "Text" | "Binary";

interface WsMessage {
  direction: "in" | "out";
  time: string;
  data: string;
  msg_type?: string;
}

interface WsIpcMessage {
  direction: string;
  data: string;
  msg_type: string;
  timestamp: string;
}

function nowTime(): string {
  const d = new Date();
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
}

export function WsPanel() {
  const { t } = useI18n();
  const [url, setUrl] = useState("wss://api.example.com/ws");
  const [status, setStatus] = useState<WsStatus>("disconnected");
  const [msgFormat, setMsgFormat] = useState<WsMsgFormat>("JSON");
  const [inputValue, setInputValue] = useState("");
  const [messages, setMessages] = useState<WsMessage[]>([]);

  const sessionIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  const handleConnect = useCallback(async () => {
    if (status === "connected") {
      // Disconnect
      if (sessionIdRef.current) {
        try {
          await invoke("ws_close", { id: sessionIdRef.current });
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
      const onMessage = new Channel<WsIpcMessage>();
      onMessage.onmessage = (msg: WsIpcMessage) => {
        setMessages((prev) => [
          ...prev,
          {
            direction: msg.direction === "in" ? "in" : "in",
            time: msg.timestamp,
            data: msg.data,
            msg_type: msg.msg_type,
          },
        ]);
      };

      const config = { url, headers: {} };
      const id = await invoke<string>("ws_connect", { config, onMessage });
      sessionIdRef.current = id;

      // Listen for close events
      const unlisten = await listen<{ session_id: string; event: string }>(
        "ws-event",
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
      console.error("WebSocket connect failed:", e);
      setStatus("disconnected");
    }
  }, [status, url]);

  const handleSend = useCallback(async () => {
    if (!inputValue.trim() || !sessionIdRef.current) return;
    try {
      await invoke("ws_send_text", { id: sessionIdRef.current, message: inputValue });
      setMessages((prev) => [
        ...prev,
        { direction: "out", time: nowTime(), data: inputValue },
      ]);
      setInputValue("");
    } catch (e) {
      console.error("WebSocket send failed:", e);
    }
  }, [inputValue]);

  return (
    <div className="ws-panel">
      <div style={{ display: "flex", gap: "var(--sp-2)", marginBottom: "var(--sp-4)" }}>
        <input
          className="url-input"
          placeholder={t("protocol.ws.urlPlaceholder")}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          style={{ flex: 1 }}
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

      {/* Message stream */}
      <div className="ws-messages">
        {messages.length === 0 ? (
          <div style={{ color: "var(--text-muted)", fontStyle: "italic", padding: "var(--sp-4)" }}>
            {t("protocol.common.noMessages")}
          </div>
        ) : (
          messages.map((msg, i) => (
            <div className="ws-msg" key={i}>
              <span className={`ws-dir ${msg.direction}`}>
                {msg.direction === "out" ? "↑" : "↓"}
              </span>
              <span className="ws-time">{msg.time}</span>
              <span className="ws-data">{msg.data}</span>
            </div>
          ))
        )}
      </div>

      {/* Input row */}
      <div className="ws-input-row">
        <Select
          className="input"
          size="sm"
          style={{ width: "80px" }}
          value={msgFormat}
          onChange={(v) => setMsgFormat(v as WsMsgFormat)}
          searchable={false}
          options={[
            { value: "JSON", label: t("protocol.ws.formats.JSON") },
            { value: "Text", label: t("protocol.ws.formats.Text") },
            { value: "Binary", label: t("protocol.ws.formats.Binary") },
          ]}
        />
        <input
          placeholder={t("protocol.ws.inputPlaceholder")}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSend()}
          disabled={status !== "connected"}
        />
        <Button
          variant="primary"
          size="sm"
          onClick={handleSend}
          disabled={status !== "connected"}
        >
          {t("protocol.common.send")}
        </Button>
      </div>
    </div>
  );
}
