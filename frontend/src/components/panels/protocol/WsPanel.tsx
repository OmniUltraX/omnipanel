import { useState, useRef, useCallback } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
      {/* Connection bar */}
      <div style={{ display: "flex", gap: "var(--sp-2)", marginBottom: "var(--sp-4)" }}>
        <input
          className="url-input"
          placeholder="wss://echo.websocket.org"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          style={{ flex: 1 }}
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

      {/* Message stream */}
      <div className="ws-messages">
        {messages.length === 0 ? (
          <div style={{ color: "var(--text-muted)", fontStyle: "italic", padding: "var(--sp-4)" }}>
            No messages
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
        <select
          className="input"
          style={{ width: "80px" }}
          value={msgFormat}
          onChange={(e) => setMsgFormat(e.target.value as WsMsgFormat)}
        >
          <option>JSON</option>
          <option>Text</option>
          <option>Binary</option>
        </select>
        <input
          placeholder={'{"type":"subscribe","channel":"..."}'}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSend()}
          disabled={status !== "connected"}
        />
        <button
          className="btn btn-primary btn-sm"
          onClick={handleSend}
          disabled={status !== "connected"}
        >
          Send
        </button>
      </div>
    </div>
  );
}
