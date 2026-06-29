import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../i18n";
import { CodeEditor } from "../../components/ui/CodeEditor";
import { Select } from "../../components/ui/Select";
import { DockHandle, DockLayout, DockPanel } from "../../components/dock";
import { quickInput } from "../../lib/quickInput";
import {
  useProtocolHttp,
  HTTP_METHOD_OPTIONS,
  isWebSocketMethod,
  type AuthType,
  type BodyType,
  type HttpMethod,
  type HttpKvPair,
} from "./ProtocolHttpContext";
import { HttpHeaderKvRow } from "./HttpHeaderKvRow";
import { HttpResponseSessionsDock } from "./HttpResponseSessionsDock";
import { HttpWebSocketPanel } from "./HttpWebSocketPanel";
import { useWebSocketSession } from "./useWebSocketSession";
import type { HttpResponseData } from "./httpResponseState";

type ReqTab = "params" | "headers" | "body" | "auth" | "scripts";

const AUTH_TYPE_KEYS: Record<
  AuthType,
  "bearerToken" | "basicAuth" | "apiKey" | "oauth2" | "authorization"
> = {
  "Bearer Token": "bearerToken",
  "Basic Auth": "basicAuth",
  "API Key": "apiKey",
  "OAuth 2.0": "oauth2",
  Authorization: "authorization",
};

const AUTH_TYPES: AuthType[] = [
  "Bearer Token",
  "Basic Auth",
  "API Key",
  "OAuth 2.0",
  "Authorization",
];

interface HttpInvokeResponse {
  status: number;
  status_text: string;
  time_ms: number;
  size_bytes: number;
  content_type: string;
  body: string;
  headers: Record<string, string>;
}

function invokeResponseToData(result: HttpInvokeResponse): HttpResponseData {
  return {
    status: result.status,
    statusText: result.status_text,
    timeMs: result.time_ms,
    sizeBytes: result.size_bytes,
    contentType: result.content_type,
    body: result.body,
    headers: result.headers,
  };
}

export function HttpPanel() {
  const { t } = useI18n();
  const {
    editor,
    setEditor,
    activeCollectionId,
    collections,
    savedRequests,
    selectedRequestId,
    saveCurrentRequest,
    persistCurrentRequest,
    renameSavedRequest,
    recordSendHistory,
    responseSessions,
    activeResponseSessionId,
    setActiveResponseSession,
    closeResponseSession,
    addResponseSession,
  } = useProtocolHttp();

  const { method, url, params, headers, body, bodyType, authType, authValue } = editor;
  const isWebSocket = isWebSocketMethod(method);
  const {
    status: wsStatus,
    messages: wsMessages,
    inputValue: wsInputValue,
    setInputValue: setWsInputValue,
    toggleConnect: toggleWsConnect,
    sendMessage: sendWsMessage,
    disconnect: disconnectWs,
  } = useWebSocketSession(url, headers);

  useEffect(() => {
    if (!isWebSocket) {
      void disconnectWs();
    }
  }, [disconnectWs, isWebSocket]);

  const setMethod = (value: HttpMethod) => {
    if (value === "WEBSOCKET" && !url.trim()) {
      setEditor({ method: value, url: "wss://api.example.com/ws" });
      return;
    }
    setEditor({ method: value });
  };
  const setUrl = (value: string) => setEditor({ url: value });
  const setParams = (value: HttpKvPair[]) => setEditor({ params: value });
  const setHeaders = (value: HttpKvPair[]) => setEditor({ headers: value });
  const setBody = (value: string) => setEditor({ body: value });
  const setBodyType = (value: BodyType) => setEditor({ bodyType: value });
  const setAuthType = (value: AuthType) => setEditor({ authType: value });
  const setAuthValue = (value: string) => setEditor({ authValue: value });

  const selectedRequest = useMemo(
    () => savedRequests.find((req) => req.id === selectedRequestId) ?? null,
    [savedRequests, selectedRequestId],
  );

  const [requestNameDraft, setRequestNameDraft] = useState("");
  const [activeTab, setActiveTab] = useState<ReqTab>("params");
  const [sending, setSending] = useState(false);
  const [saveRequestName, setSaveRequestName] = useState("");
  const [showSaveDialog, setShowSaveDialog] = useState(false);

  useEffect(() => {
    setRequestNameDraft(selectedRequest?.name ?? "");
  }, [selectedRequest?.id, selectedRequest?.name]);

  const updateKv = (
    list: HttpKvPair[],
    setList: (v: HttpKvPair[]) => void,
    idx: number,
    field: keyof HttpKvPair,
    value: string | boolean,
  ) => {
    const next = [...list];
    next[idx] = { ...next[idx], [field]: value };
    setList(next);
  };

  const removeKv = (list: HttpKvPair[], setList: (v: HttpKvPair[]) => void, idx: number) => {
    setList(list.filter((_, i) => i !== idx));
  };

  const addKv = (list: HttpKvPair[], setList: (v: HttpKvPair[]) => void) => {
    setList([...list, { key: "", value: "", enabled: true }]);
  };

  const handleSend = useCallback(async () => {
    setSending(true);
    try {
      const enabledParams = params.filter((p) => p.enabled && p.key);
      const enabledHeaders = headers.filter((h) => h.enabled && h.key);

      const queryParams: Record<string, string> = {};
      for (const p of enabledParams) {
        queryParams[p.key] = p.value;
      }

      const headerMap: Record<string, string> = {};
      for (const h of enabledHeaders) {
        headerMap[h.key] = h.value;
      }

      const trimmedAuthValue = authValue.trim();
      const config = {
        method,
        url,
        headers: headerMap,
        query_params: queryParams,
        body: bodyType !== "Binary" ? body : null,
        body_type: bodyType.toLowerCase(),
        auth_type: trimmedAuthValue ? authType : null,
        auth_value: trimmedAuthValue || null,
        timeout_ms: 30000,
      };

      const result = await invoke<HttpInvokeResponse>("http_request", { config });
      const response = invokeResponseToData(result);

      try {
        await recordSendHistory({
          method,
          url,
          statusCode: result.status,
          responseTimeMs: result.time_ms,
          requestSize: body ? new TextEncoder().encode(body).length : 0,
          responseSize: result.size_bytes,
          response,
        });
      } catch {
        addResponseSession(response, null);
      }
    } catch (e) {
      const response: HttpResponseData = {
        status: 0,
        statusText: "Error",
        timeMs: 0,
        sizeBytes: 0,
        contentType: "text/plain",
        body: String(e),
        headers: {},
      };
      addResponseSession(response, null);
    } finally {
      setSending(false);
    }
  }, [
    method,
    url,
    params,
    headers,
    body,
    bodyType,
    authType,
    authValue,
    recordSendHistory,
    addResponseSession,
  ]);

  const handleSaveRequest = async () => {
    if (!saveRequestName.trim()) return;
    await saveCurrentRequest(saveRequestName.trim(), activeCollectionId);
    setSaveRequestName("");
    setShowSaveDialog(false);
  };

  const handlePersist = useCallback(async () => {
    if (selectedRequestId) {
      await persistCurrentRequest();
      return;
    }
    const name = await quickInput({
      title: t("protocol.sidebar.newRequestTitle"),
      placeholder: t("protocol.http.requestName"),
      defaultValue: t("protocol.sidebar.defaultRequestName"),
      validate: (value) => (value.trim() ? null : t("protocol.sidebar.folderNameRequired")),
    });
    if (!name) return;
    await saveCurrentRequest(name.trim(), activeCollectionId);
  }, [activeCollectionId, persistCurrentRequest, saveCurrentRequest, selectedRequestId, t]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      if (event.shiftKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      void handlePersist();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [handlePersist]);

  const commitRequestName = useCallback(async () => {
    if (!selectedRequestId) return;
    const trimmed = requestNameDraft.trim();
    if (!trimmed || trimmed === selectedRequest?.name) {
      setRequestNameDraft(selectedRequest?.name ?? "");
      return;
    }
    await renameSavedRequest(selectedRequestId, trimmed);
  }, [renameSavedRequest, requestNameDraft, selectedRequest?.name, selectedRequestId]);

  const tabs: ReqTab[] = ["params", "headers", "body", "auth", "scripts"];
  const bodyFill = !isWebSocket && activeTab === "body" && bodyType === "JSON";
  const hasResponsePanel = !isWebSocket && responseSessions.length > 0;

  const editorContent = (
    <div className={`http-panel${bodyFill ? " http-panel--body-fill" : ""}${isWebSocket ? " http-panel--ws" : ""}`}>
      <div className="http-panel__chrome">
        {selectedRequest ? (
          <div className="http-request-name-row">
            <input
              className="http-request-name-input"
              value={requestNameDraft}
              onChange={(e) => setRequestNameDraft(e.target.value)}
              onBlur={() => void commitRequestName()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.currentTarget.blur();
                }
                if (e.key === "Escape") {
                  setRequestNameDraft(selectedRequest.name);
                  e.currentTarget.blur();
                }
              }}
              placeholder={t("protocol.http.requestName")}
              aria-label={t("protocol.http.requestName")}
            />
          </div>
        ) : null}

        <div className="http-builder">
          <Select
            className="method-select"
            value={method}
            onChange={(v) => setMethod(v as HttpMethod)}
            searchable={false}
            options={HTTP_METHOD_OPTIONS}
          />
          <input
            className="url-input"
            placeholder={
              isWebSocket ? t("protocol.ws.urlPlaceholder") : t("protocol.http.urlPlaceholder")
            }
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={isWebSocket && wsStatus === "connected"}
          />
          {isWebSocket ? (
            <>
              <span
                className={`badge http-ws-badge ${wsStatus === "connected" ? "badge-success" : "badge-muted"}`}
              >
                {wsStatus === "connecting"
                  ? t("protocol.common.connecting")
                  : wsStatus === "connected"
                    ? t("protocol.common.connected")
                    : t("protocol.common.disconnected")}
              </span>
              <button
                className={`btn ${wsStatus === "connected" ? "btn-danger" : "btn-primary"}`}
                onClick={() => void toggleWsConnect()}
                disabled={wsStatus === "connecting" || !url.trim()}
              >
                {wsStatus === "connected"
                  ? t("protocol.common.disconnect")
                  : wsStatus === "connecting"
                    ? t("protocol.common.connecting")
                    : t("protocol.common.connect")}
              </button>
            </>
          ) : (
            <button className="btn btn-primary" onClick={() => void handleSend()} disabled={sending}>
              {sending ? t("protocol.common.sending") : t("protocol.common.send")}
            </button>
          )}
          <button
            className="btn btn-secondary"
            onClick={() => {
              if (selectedRequestId) {
                void handlePersist();
                return;
              }
              setShowSaveDialog(true);
            }}
            title={t("protocol.http.saveShortcut")}
          >
            {t("protocol.common.save")}
          </button>
        </div>

        {showSaveDialog ? (
          <div className="http-save-dialog">
            <input
              value={saveRequestName}
              onChange={(e) => setSaveRequestName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void handleSaveRequest()}
              placeholder={t("protocol.http.requestName")}
              autoFocus
            />
            {activeCollectionId ? (
              <span className="http-save-dialog__meta">
                → {collections.find((c) => c.id === activeCollectionId)?.name}
              </span>
            ) : null}
            <button className="btn btn-primary btn-sm" onClick={() => void handleSaveRequest()}>
              {t("protocol.common.save")}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setShowSaveDialog(false);
                setSaveRequestName("");
              }}
            >
              {t("protocol.common.cancel")}
            </button>
          </div>
        ) : null}

        {!isWebSocket ? (
        <div className="req-tabs">
          {tabs.map((tab) => (
            <span
              key={tab}
              className={`req-tab${activeTab === tab ? " active" : ""}`}
              onClick={() => setActiveTab(tab)}
            >
              {t(`protocol.http.tabs.${tab}`)}
            </span>
          ))}
        </div>
        ) : null}
      </div>

      <div className="http-panel__content">
        {isWebSocket ? (
          <div className="http-panel__ws-content">
            <div className="req-panel req-panel--ws-headers active">
              <div className="kv-editor">
                {headers.map((h, i) => (
                  <HttpHeaderKvRow
                    key={i}
                    pair={h}
                    onChange={(patch) => {
                      const next = [...headers];
                      next[i] = { ...next[i], ...patch };
                      setHeaders(next);
                    }}
                    onRemove={() => removeKv(headers, setHeaders, i)}
                  />
                ))}
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => addKv(headers, setHeaders)}>
                + {t("protocol.common.addHeader")}
              </button>
            </div>
            <HttpWebSocketPanel
              messages={wsMessages}
              inputValue={wsInputValue}
              onInputChange={setWsInputValue}
              onSend={() => void sendWsMessage()}
              connected={wsStatus === "connected"}
            />
          </div>
        ) : null}

        {!isWebSocket && activeTab === "params" ? (
          <div className="req-panel active">
            <div className="kv-editor">
              {params.map((p, i) => (
                <div className="kv-row" key={i}>
                  <input
                    type="checkbox"
                    className="kv-check"
                    checked={p.enabled}
                    onChange={(e) => updateKv(params, setParams, i, "enabled", e.target.checked)}
                  />
                  <input
                    placeholder={t("protocol.common.key")}
                    value={p.key}
                    onChange={(e) => updateKv(params, setParams, i, "key", e.target.value)}
                  />
                  <input
                    placeholder={t("protocol.common.value")}
                    value={p.value}
                    onChange={(e) => updateKv(params, setParams, i, "value", e.target.value)}
                  />
                  <div className="kv-del" onClick={() => removeKv(params, setParams, i)}>
                    {"×"}
                  </div>
                </div>
              ))}
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => addKv(params, setParams)}>
              + {t("protocol.common.addParam")}
            </button>
          </div>
        ) : null}

        {!isWebSocket && activeTab === "headers" ? (
          <div className="req-panel active">
            <div className="kv-editor">
              {headers.map((h, i) => (
                <HttpHeaderKvRow
                  key={i}
                  pair={h}
                  onChange={(patch) => {
                    const next = [...headers];
                    next[i] = { ...next[i], ...patch };
                    setHeaders(next);
                  }}
                  onRemove={() => removeKv(headers, setHeaders, i)}
                />
              ))}
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => addKv(headers, setHeaders)}>
              + {t("protocol.common.addHeader")}
            </button>
          </div>
        ) : null}

        {!isWebSocket && activeTab === "body" ? (
          <div className={`req-panel active${bodyType === "JSON" ? " req-panel--fill" : ""}`}>
            <div className="http-body-type-row">
              {(["JSON", "Form", "Multipart", "Raw", "Binary"] as BodyType[]).map((bt) => (
                <span
                  key={bt}
                  className="tag"
                  style={{
                    cursor: "pointer",
                    borderColor: bodyType === bt ? "var(--accent)" : undefined,
                    color: bodyType === bt ? "var(--accent)" : undefined,
                  }}
                  onClick={() => setBodyType(bt)}
                >
                  {t(`protocol.http.bodyTypes.${bt}`)}
                </span>
              ))}
            </div>
            {bodyType === "JSON" ? (
              <div className="http-json-editor">
                <CodeEditor
                  className="http-json-editor__cm"
                  language="json"
                  value={body}
                  onChange={setBody}
                  height="100%"
                />
              </div>
            ) : (
              <textarea
                className="body-editor"
                placeholder={t("protocol.http.requestBody")}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            )}
          </div>
        ) : null}

        {!isWebSocket && activeTab === "auth" ? (
          <div className="req-panel active">
            <div style={{ marginBottom: "var(--sp-3)" }}>
              <div
                style={{
                  display: "flex",
                  gap: "var(--sp-2)",
                  marginBottom: "var(--sp-3)",
                  flexWrap: "wrap",
                }}
              >
                {AUTH_TYPES.map((auth) => (
                  <span
                    key={auth}
                    className="tag"
                    style={{
                      cursor: "pointer",
                      borderColor: authType === auth ? "var(--accent)" : undefined,
                      color: authType === auth ? "var(--accent)" : undefined,
                    }}
                    onClick={() => setAuthType(auth)}
                  >
                    {t(`protocol.http.authTypes.${AUTH_TYPE_KEYS[auth]}`)}
                  </span>
                ))}
              </div>
              <div className="kv-editor">
                <div className="kv-row">
                  <input
                    placeholder={
                      authType === "Authorization"
                        ? t("protocol.http.authAuthorizationPlaceholder")
                        : t("protocol.http.token")
                    }
                    value={authValue}
                    onChange={(e) => setAuthValue(e.target.value)}
                    style={{ flex: 3 }}
                  />
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {!isWebSocket && activeTab === "scripts" ? (
          <div className="req-panel active">
            <div style={{ marginBottom: "var(--sp-2)" }}>
              <h4 style={{ fontSize: "12px", fontWeight: 600, marginBottom: "var(--sp-2)" }}>
                {t("protocol.http.preRequestScript")}
              </h4>
              <textarea
                className="body-editor"
                style={{ minHeight: "80px" }}
                placeholder={t("protocol.http.preRequestPlaceholder")}
              />
            </div>
            <div>
              <h4 style={{ fontSize: "12px", fontWeight: 600, marginBottom: "var(--sp-2)" }}>
                {t("protocol.http.testScript")}
              </h4>
              <textarea
                className="body-editor"
                style={{ minHeight: "80px" }}
                placeholder={t("protocol.http.testPlaceholder")}
              />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );

  const resultsContent = (
    <div className="http-response-area">
      <HttpResponseSessionsDock
        sessions={responseSessions}
        activeSessionId={activeResponseSessionId}
        onActiveSessionChange={setActiveResponseSession}
        onCloseSession={closeResponseSession}
      />
    </div>
  );

  if (!hasResponsePanel) {
    return editorContent;
  }

  return (
    <DockLayout direction="vertical" className="http-response-split">
      <DockPanel defaultSize={55} minSize={160}>
        {editorContent}
      </DockPanel>
      <DockHandle direction="vertical" />
      <DockPanel defaultSize={45} minSize={120} className="dock-panel-bottom">
        {resultsContent}
      </DockPanel>
    </DockLayout>
  );
}
