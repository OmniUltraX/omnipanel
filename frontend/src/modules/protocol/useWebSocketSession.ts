import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { HttpKvPair } from "./ProtocolHttpContext";

type WsStatus = "disconnected" | "connecting" | "connected";

export interface WsMessage {
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

function buildHeaderMap(headers: HttpKvPair[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const header of headers) {
    if (header.enabled && header.key) {
      map[header.key] = header.value;
    }
  }
  return map;
}

export function useWebSocketSession(url: string, headers: HttpKvPair[]) {
  const [status, setStatus] = useState<WsStatus>("disconnected");
  const [inputValue, setInputValue] = useState("");
  const [messages, setMessages] = useState<WsMessage[]>([]);

  const sessionIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  const disconnect = useCallback(async () => {
    if (sessionIdRef.current) {
      try {
        await invoke("ws_close", { id: sessionIdRef.current });
      } catch {
        /* ignore */
      }
      sessionIdRef.current = null;
    }
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
    setStatus("disconnected");
  }, []);

  useEffect(() => {
    return () => {
      void disconnect();
    };
  }, [disconnect]);

  const toggleConnect = useCallback(async () => {
    if (status === "connected") {
      await disconnect();
      return;
    }

    setStatus("connecting");
    try {
      const onMessage = new Channel<WsIpcMessage>();
      onMessage.onmessage = (msg: WsIpcMessage) => {
        setMessages((prev) => [
          ...prev,
          {
            direction: msg.direction === "out" ? "out" : "in",
            time: msg.timestamp,
            data: msg.data,
            msg_type: msg.msg_type,
          },
        ]);
      };

      const config = { url, headers: buildHeaderMap(headers) };
      const id = await invoke<string>("ws_connect", { config, onMessage });
      sessionIdRef.current = id;

      const unlisten = await listen<{ session_id: string; event: string }>("ws-event", (event) => {
        if (event.payload.session_id === id) {
          void disconnect();
        }
      });
      unlistenRef.current = unlisten;

      setStatus("connected");
    } catch (e) {
      console.error("WebSocket connect failed:", e);
      setStatus("disconnected");
    }
  }, [disconnect, headers, status, url]);

  const sendMessage = useCallback(async () => {
    if (!inputValue.trim() || !sessionIdRef.current) return;
    try {
      await invoke("ws_send_text", { id: sessionIdRef.current, message: inputValue });
      setMessages((prev) => [...prev, { direction: "out", time: nowTime(), data: inputValue }]);
      setInputValue("");
    } catch (e) {
      console.error("WebSocket send failed:", e);
    }
  }, [inputValue]);

  return {
    status,
    messages,
    inputValue,
    setInputValue,
    toggleConnect,
    sendMessage,
    disconnect,
  };
}
