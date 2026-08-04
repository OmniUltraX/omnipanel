import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { buildHeaderMap } from "./httpHeaderUtils";
import type { HttpHeaderPair } from "./httpHeaderUtils";
import type { AuthType, BodyType, HttpKvPair, HttpMethod } from "./ProtocolHttpContext";
import { resolveEffectiveAuth } from "./httpEnvironment";
import { applyHttpAuthHeaders } from "./httpCurlCommand";

type SseStatus = "disconnected" | "connecting" | "connected";

export interface SseEventItem {
  event: string;
  data: string;
  id: string;
  time: string;
}

interface SseIpcEvent {
  event: string;
  data: string;
  id: string;
  timestamp: string;
}

function appendQueryParams(url: string, params: HttpKvPair[]): string {
  const enabled = params.filter((p) => p.enabled && p.key.trim());
  if (enabled.length === 0) return url;
  try {
    const parsed = new URL(url);
    for (const p of enabled) {
      parsed.searchParams.append(p.key.trim(), p.value);
    }
    return parsed.toString();
  } catch {
    const q = enabled
      .map((p) => `${encodeURIComponent(p.key.trim())}=${encodeURIComponent(p.value)}`)
      .join("&");
    return url.includes("?") ? `${url}&${q}` : `${url}?${q}`;
  }
}

export function useSseSession(options: {
  url: string;
  method: HttpMethod;
  headers: HttpHeaderPair[];
  params: HttpKvPair[];
  body?: string | null;
  bodyType?: BodyType;
  authType: AuthType;
  authValue: string;
  envAuthType?: string | null;
  envAuthValue?: string | null;
}) {
  const {
    url,
    method,
    headers,
    params,
    body,
    bodyType,
    authType,
    authValue,
    envAuthType,
    envAuthValue,
  } = options;
  const [status, setStatus] = useState<SseStatus>("disconnected");
  const [events, setEvents] = useState<SseEventItem[]>([]);

  const sessionIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  const disconnect = useCallback(async () => {
    if (sessionIdRef.current) {
      try {
        await invoke("sse_close", { id: sessionIdRef.current });
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

  const clearEvents = useCallback(() => {
    setEvents([]);
  }, []);

  const toggleConnect = useCallback(async () => {
    if (status === "connected") {
      await disconnect();
      return;
    }

    setStatus("connecting");
    try {
      const onEvent = new Channel<SseIpcEvent>();
      onEvent.onmessage = (msg: SseIpcEvent) => {
        setEvents((prev) => [
          ...prev,
          {
            event: msg.event || "message",
            data: msg.data,
            id: msg.id ?? "",
            time: msg.timestamp,
          },
        ]);
      };

      const headerMap = await buildHeaderMap(headers);
      const effectiveAuth = resolveEffectiveAuth(authType, authValue, envAuthType, envAuthValue);
      // 与普通 HTTP 一致：headers 里带一份，同时传 auth_* 给 Rust（后端再注入，避免漏带）
      const withAuth = applyHttpAuthHeaders(
        headerMap,
        effectiveAuth.authType,
        effectiveAuth.authValue,
      );
      const finalUrl = appendQueryParams(url, params);
      const config = {
        method,
        url: finalUrl,
        headers: withAuth,
        body: body && bodyType !== "Binary" ? body : null,
        bodyType: bodyType?.toLowerCase() ?? null,
        authType: effectiveAuth.authType,
        authValue: effectiveAuth.authValue,
      };
      console.info("[protocol/sse] connect request", {
        url: finalUrl,
        method,
        headers: withAuth,
        requestAuth: { authType, authValue },
        envAuth: { envAuthType, envAuthValue },
        effectiveAuth,
        config,
      });
      const id = await invoke<string>("sse_connect", { config, onEvent });
      console.info("[protocol/sse] connected", { id });
      sessionIdRef.current = id;

      const unlisten = await listen<{ session_id: string; event: string }>("sse-event", (event) => {
        if (event.payload.session_id === id) {
          void disconnect();
        }
      });
      unlistenRef.current = unlisten;

      setStatus("connected");
    } catch (e) {
      console.error("SSE connect failed:", e);
      setStatus("disconnected");
    }
  }, [
    authType,
    authValue,
    body,
    bodyType,
    disconnect,
    envAuthType,
    envAuthValue,
    headers,
    method,
    params,
    status,
    url,
  ]);

  return {
    status,
    events,
    toggleConnect,
    disconnect,
    clearEvents,
  };
}
