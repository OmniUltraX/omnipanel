import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../i18n";
import { CodeEditor } from "../../components/ui/CodeEditor";
import { Select } from "../../components/ui/Select";
import { TextInput } from "../../components/ui/TextInput";
import { GlobalTagEditor } from "../tags/GlobalTagEditor";
import { DockHandle, DockLayout, DockPanel } from "../../components/dock";
import { quickInput } from "../../lib/quickInput";
import {
  useProtocolHttp,
  HTTP_METHOD_OPTIONS,
  SSE_HTTP_METHOD_OPTIONS,
  isWebSocketMethod,
  AUTH_TYPES,
  AUTH_TYPE_I18N_KEYS,
  type AuthType,
  type BodyType,
  type HttpMethod,
  type HttpKvPair,
} from "./ProtocolHttpContext";
import { buildHeaderMap, createEmptyHeader, type HttpHeaderPair } from "./httpHeaderUtils";
import { buildHttpCurlCommand } from "./httpCurlCommand";
import { HttpHeaderKvRow } from "./HttpHeaderKvRow";
import { HttpResponseSessionsDock } from "./HttpResponseSessionsDock";
import { HttpSsePanel } from "./HttpSsePanel";
import { HttpWebSocketPanel } from "./HttpWebSocketPanel";
import { useSseSession } from "./useSseSession";
import { useWebSocketSession } from "./useWebSocketSession";
import type { HttpResponseData } from "./httpResponseState";
import { resolveEffectiveAuth, resolveHttpRequestUrl } from "./httpEnvironment";
import {
  extractPathParamNames,
  hasUnresolvedPathParams,
  syncPathParamsFromUrl,
} from "./httpPathParams";
import type { HttpPathParamPair } from "./httpPathParams";

type ReqTab = "path" | "params" | "headers" | "body" | "auth" | "scripts";

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

/** 发送时自动保存：无选中请求时用 URL 推导名称 */
function suggestRequestNameFromUrl(url: string, fallback: string): string {
  const trimmed = url.trim();
  if (!trimmed) return fallback;
  try {
    const withProto = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = new URL(withProto);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    const name = `${parsed.host}${path}`.slice(0, 80);
    return name || fallback;
  } catch {
    return trimmed.slice(0, 80) || fallback;
  }
}

export function HttpPanel() {
  const { t } = useI18n();
  const {
    editor,
    setEditor,
    activeCollectionId,
    collections,
    environments,
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

  const { method, sseEnabled, environmentId, url, pathParams, params, headers, body, bodyType, authType, authValue } =
    editor;
  const isWebSocket = isWebSocketMethod(method);
  const isSse = sseEnabled;
  const isLiveStream = isWebSocket || isSse;
  const sseAllowsBody = isSse && method !== "GET" && method !== "HEAD" && method !== "OPTIONS";

  const pathParamNames = useMemo(() => extractPathParamNames(url), [url]);

  const resolvedRequestUrl = useMemo(
    () => resolveHttpRequestUrl(url, environmentId, environments, pathParams),
    [url, environmentId, environments, pathParams],
  );

  const activeEnv =
    (environmentId ? environments.find((item) => item.id === environmentId) : null) ??
    environments[0] ??
    null;

  const {
    status: wsStatus,
    messages: wsMessages,
    inputValue: wsInputValue,
    setInputValue: setWsInputValue,
    toggleConnect: toggleWsConnect,
    sendMessage: sendWsMessage,
    disconnect: disconnectWs,
  } = useWebSocketSession(resolvedRequestUrl ?? "", headers);

  const {
    status: sseStatus,
    events: sseEvents,
    toggleConnect: toggleSseConnect,
    disconnect: disconnectSse,
    clearEvents: clearSseEvents,
  } = useSseSession({
    url: resolvedRequestUrl ?? "",
    method,
    headers,
    params,
    body: sseAllowsBody ? body : null,
    bodyType,
    authType,
    authValue,
    envAuthType: activeEnv?.authType,
    envAuthValue: activeEnv?.authValue,
  });

  useEffect(() => {
    if (!isWebSocket) {
      void disconnectWs();
    }
  }, [disconnectWs, isWebSocket]);

  useEffect(() => {
    if (!isSse) {
      void disconnectSse();
    }
  }, [disconnectSse, isSse]);

  const setMethod = (value: HttpMethod) => {
    if (value === "WEBSOCKET") {
      const patch: { method: HttpMethod; sseEnabled: boolean; url?: string } = {
        method: value,
        sseEnabled: false,
      };
      if (!url.trim()) {
        patch.url = "/ws";
      }
      setEditor(patch);
      return;
    }
    setEditor({ method: value });
  };

  const setSseEnabled = (enabled: boolean) => {
    if (enabled) {
      const patch: {
        sseEnabled: boolean;
        method?: HttpMethod;
        url?: string;
      } = { sseEnabled: true };
      if (isWebSocketMethod(method)) {
        patch.method = "GET";
      }
      if (!url.trim()) {
        patch.url = "/events";
      }
      setEditor(patch);
      return;
    }
    setEditor({ sseEnabled: false });
  };
  const setEnvironmentId = (value: string) => setEditor({ environmentId: value || null });
  const setUrl = (value: string) => {
    setEditor({
      url: value,
      pathParams: syncPathParamsFromUrl(value, pathParams),
    });
  };
  const setPathParams = (value: HttpPathParamPair[]) => setEditor({ pathParams: value });
  const setParams = (value: HttpKvPair[]) => setEditor({ params: value });
  const setHeaders = (value: HttpHeaderPair[]) => setEditor({ headers: value });
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

  const removeHeader = (idx: number) => {
    setHeaders(headers.filter((_, i) => i !== idx));
  };

  const addPresetHeader = () => {
    setHeaders([...headers, createEmptyHeader("preset")]);
  };

  const addCustomHeader = () => {
    setHeaders([...headers, createEmptyHeader("custom")]);
  };

  const handleSend = useCallback(async () => {
    if (!resolvedRequestUrl) return;
    setSending(true);
    try {
      // 发送前自动保存当前请求，保证历史能挂到具体 requestId
      let requestIdForHistory = selectedRequestId;
      if (selectedRequestId) {
        await persistCurrentRequest();
      } else {
        const name = suggestRequestNameFromUrl(
          resolvedRequestUrl,
          t("protocol.sidebar.defaultRequestName"),
        );
        requestIdForHistory = await saveCurrentRequest(name, activeCollectionId);
      }

      const enabledParams = params.filter((p) => p.enabled && p.key);

      const queryParams: Record<string, string> = {};
      for (const p of enabledParams) {
        queryParams[p.key] = p.value;
      }

      const headerMap = await buildHeaderMap(headers);

      const activeEnv =
        (environmentId ? environments.find((item) => item.id === environmentId) : null) ??
        environments[0] ??
        null;
      const effectiveAuth = resolveEffectiveAuth(
        authType,
        authValue,
        activeEnv?.authType,
        activeEnv?.authValue,
      );
      const curlCommand = buildHttpCurlCommand({
        method,
        url: resolvedRequestUrl,
        headers: headerMap,
        queryParams,
        body: bodyType !== "Binary" ? body : null,
        authType: effectiveAuth.authType,
        authValue: effectiveAuth.authValue,
      });
      const config = {
        method,
        url: resolvedRequestUrl,
        headers: headerMap,
        query_params: queryParams,
        body: bodyType !== "Binary" ? body : null,
        body_type: bodyType.toLowerCase(),
        auth_type: effectiveAuth.authType,
        auth_value: effectiveAuth.authValue,
        timeout_ms: 30000,
      };

      const result = await invoke<HttpInvokeResponse>("http_request", { config });
      const response = invokeResponseToData(result);

      try {
        await recordSendHistory({
          method,
          url: resolvedRequestUrl,
          environmentId,
          statusCode: result.status,
          responseTimeMs: result.time_ms,
          requestSize: body ? new TextEncoder().encode(body).length : 0,
          responseSize: result.size_bytes,
          response,
          curlCommand,
          requestId: requestIdForHistory,
        });
      } catch {
        addResponseSession(response, null, curlCommand);
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
    resolvedRequestUrl,
    environmentId,
    environments,
    params,
    headers,
    body,
    bodyType,
    authType,
    authValue,
    selectedRequestId,
    activeCollectionId,
    persistCurrentRequest,
    saveCurrentRequest,
    recordSendHistory,
    addResponseSession,
    t,
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

  const tabs: ReqTab[] = useMemo(() => {
    const base: ReqTab[] = pathParamNames.length > 0 ? ["path"] : [];
    if (isSse) {
      return sseAllowsBody
        ? [...base, "params", "headers", "body", "auth"]
        : [...base, "params", "headers", "auth"];
    }
    return [...base, "params", "headers", "body", "auth", "scripts"];
  }, [isSse, pathParamNames.length, sseAllowsBody]);

  useEffect(() => {
    if (activeTab === "path" && pathParamNames.length === 0) {
      setActiveTab("params");
    }
  }, [activeTab, pathParamNames.length]);

  useEffect(() => {
    if (isSse && activeTab === "scripts") {
      setActiveTab("params");
    }
    if (isSse && activeTab === "body" && !sseAllowsBody) {
      setActiveTab("params");
    }
  }, [activeTab, isSse, sseAllowsBody]);

  const prevPathParamCountRef = useRef(0);
  useEffect(() => {
    if (pathParamNames.length > prevPathParamCountRef.current && pathParamNames.length > 0) {
      setActiveTab("path");
    }
    prevPathParamCountRef.current = pathParamNames.length;
  }, [pathParamNames.length]);

  const bodyFill = !isLiveStream && activeTab === "body";
  const hasResponsePanel = !isLiveStream && responseSessions.length > 0;
  const pathParamsReady = pathParamNames.length === 0 || !hasUnresolvedPathParams(url, pathParams);
  const canSendRequest = Boolean(resolvedRequestUrl?.trim()) && pathParamsReady;
  const liveStatus = isWebSocket ? wsStatus : sseStatus;
  const environmentOptions = useMemo(
    () => environments.map((env) => ({ value: env.id, label: env.name })),
    [environments],
  );

  const editorContent = (
    <div className={`http-panel${bodyFill ? " http-panel--body-fill" : ""}${isLiveStream ? " http-panel--ws" : ""}${isSse ? " http-panel--sse" : ""}`}>
      <div className="http-panel__chrome">
        {selectedRequest ? (
          <div className="http-request-name-row">
            <TextInput
              className="http-request-name-input"
              value={requestNameDraft}
              onChange={setRequestNameDraft}
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
            <GlobalTagEditor
              kind="http_request"
              resourceId={selectedRequest.id}
            />
          </div>
        ) : null}

        <div className="http-builder">
          <Select
            className="method-select"
            value={method}
            onChange={(v) => setMethod(v as HttpMethod)}
            searchable={false}
            options={isSse ? SSE_HTTP_METHOD_OPTIONS : HTTP_METHOD_OPTIONS}
            disabled={isLiveStream && liveStatus === "connected"}
          />
          <Select
            className="env-select"
            value={environmentId ?? ""}
            onChange={setEnvironmentId}
            searchable={false}
            placeholder={t("protocol.environment.selectPlaceholder")}
            options={environmentOptions}
            disabled={environmentOptions.length === 0}
          />
          <TextInput
            className="url-input"
            placeholder={
              isWebSocket
                ? t("protocol.ws.pathPlaceholder")
                : isSse
                  ? t("protocol.sse.pathPlaceholder")
                  : t("protocol.http.pathPlaceholder")
            }
            value={url}
            onChange={setUrl}
            disabled={isLiveStream && liveStatus === "connected"}
            title={resolvedRequestUrl ?? undefined}
          />
          {isLiveStream ? (
            <>
              <span
                className={`badge http-ws-badge ${liveStatus === "connected" ? "badge-success" : "badge-muted"}`}
              >
                {liveStatus === "connecting"
                  ? t("protocol.common.connecting")
                  : liveStatus === "connected"
                    ? t("protocol.common.connected")
                    : t("protocol.common.disconnected")}
              </span>
              <button
                className={`btn ${liveStatus === "connected" ? "btn-danger" : "btn-primary"}`}
                onClick={() => void (isWebSocket ? toggleWsConnect() : toggleSseConnect())}
                disabled={liveStatus === "connecting" || !canSendRequest}
              >
                {liveStatus === "connected"
                  ? t("protocol.common.disconnect")
                  : liveStatus === "connecting"
                    ? t("protocol.common.connecting")
                    : t("protocol.common.connect")}
              </button>
            </>
          ) : (
            <button
              className="btn btn-primary"
              onClick={() => void handleSend()}
              disabled={sending || !canSendRequest}
            >
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

        <div className="http-sse-row">
          <label
            className={`http-sse-toggle${sseEnabled ? " http-sse-toggle--active" : ""}`}
            title={t("protocol.sse.toggleHint")}
          >
            <input
              type="checkbox"
              checked={sseEnabled}
              onChange={(e) => setSseEnabled(e.target.checked)}
              disabled={isLiveStream && liveStatus === "connected"}
            />
            <span>{t("protocol.sse.toggle")}</span>
          </label>
        </div>

        {showSaveDialog ? (
          <div className="http-save-dialog">
            <TextInput
              value={saveRequestName}
              onChange={setSaveRequestName}
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
                    onRemove={() => removeHeader(i)}
                  />
                ))}
              </div>
              <div className="kv-editor-actions">
                <button className="btn btn-ghost btn-sm" onClick={addPresetHeader}>
                  + {t("protocol.http.addPresetHeader")}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={addCustomHeader}>
                  + {t("protocol.http.addCustomHeader")}
                </button>
              </div>
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

        {isSse ? (
          <div className="http-panel__sse-content">
            <div className="http-panel__sse-editor">
              {activeTab === "path" ? (
                <div className="req-panel active">
                  <div className="kv-editor">
                    {pathParams.map((p, i) => (
                      <div className="kv-row kv-row--path-param" key={p.key}>
                        <input
                          type="checkbox"
                          className="kv-check"
                          checked={p.enabled}
                          onChange={(e) =>
                            updateKv(pathParams, setPathParams, i, "enabled", e.target.checked)
                          }
                        />
                        <span className="http-path-param-key" title={p.key}>
                          :{p.key}
                        </span>
                        <TextInput
                          className="http-path-param-value"
                          placeholder={t("protocol.http.pathParamValue")}
                          value={p.value}
                          onChange={(value) => updateKv(pathParams, setPathParams, i, "value", value)}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {activeTab === "params" ? (
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
                        <TextInput
                          placeholder={t("protocol.common.key")}
                          value={p.key}
                          onChange={(value) => updateKv(params, setParams, i, "key", value)}
                        />
                        <TextInput
                          placeholder={t("protocol.common.value")}
                          value={p.value}
                          onChange={(value) => updateKv(params, setParams, i, "value", value)}
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
              {activeTab === "headers" ? (
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
                        onRemove={() => removeHeader(i)}
                      />
                    ))}
                  </div>
                  <div className="kv-editor-actions">
                    <button className="btn btn-ghost btn-sm" onClick={addPresetHeader}>
                      + {t("protocol.http.addPresetHeader")}
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={addCustomHeader}>
                      + {t("protocol.http.addCustomHeader")}
                    </button>
                  </div>
                </div>
              ) : null}
              {activeTab === "body" && sseAllowsBody ? (
                <div className="req-panel active">
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
                    <div className="http-json-editor" style={{ minHeight: 160 }}>
                      <CodeEditor
                        key="http-sse-json-body"
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
              {activeTab === "auth" ? (
                <div className="req-panel active">
                  <div className="auth-section">
                    <div className="form-row">
                      <label>{t("protocol.http.tabs.auth")}</label>
                      <div className="form-row-inline">
                        <Select
                          value={authType}
                          onChange={(v) => setAuthType(v as AuthType)}
                          searchable={false}
                          options={AUTH_TYPES.map((type) => ({
                            value: type,
                            label: t(`protocol.http.authTypes.${AUTH_TYPE_I18N_KEYS[type]}`),
                          }))}
                          style={{ flex: 2 }}
                        />
                        <TextInput
                          placeholder={t("protocol.http.token")}
                          value={authValue}
                          onChange={setAuthValue}
                          style={{ flex: 3 }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
            <HttpSsePanel
              events={sseEvents}
              connected={sseStatus === "connected"}
              onClear={clearSseEvents}
            />
          </div>
        ) : null}

        {!isLiveStream && activeTab === "path" ? (
          <div className="req-panel active">
            <div className="kv-editor">
              {pathParams.map((p, i) => (
                <div className="kv-row kv-row--path-param" key={p.key}>
                  <input
                    type="checkbox"
                    className="kv-check"
                    checked={p.enabled}
                    onChange={(e) =>
                      updateKv(pathParams, setPathParams, i, "enabled", e.target.checked)
                    }
                  />
                  <span className="http-path-param-key" title={p.key}>
                    :{p.key}
                  </span>
                  <TextInput
                    className="http-path-param-value"
                    placeholder={t("protocol.http.pathParamValue")}
                    value={p.value}
                    onChange={(value) => updateKv(pathParams, setPathParams, i, "value", value)}
                  />
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {!isLiveStream && activeTab === "params" ? (
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
                  <TextInput
                    placeholder={t("protocol.common.key")}
                    value={p.key}
                    onChange={(value) => updateKv(params, setParams, i, "key", value)}
                  />
                  <TextInput
                    placeholder={t("protocol.common.value")}
                    value={p.value}
                    onChange={(value) => updateKv(params, setParams, i, "value", value)}
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

        {!isLiveStream && activeTab === "headers" ? (
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
                  onRemove={() => removeHeader(i)}
                />
              ))}
            </div>
            <div className="kv-editor-actions">
              <button className="btn btn-ghost btn-sm" onClick={addPresetHeader}>
                + {t("protocol.http.addPresetHeader")}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={addCustomHeader}>
                + {t("protocol.http.addCustomHeader")}
              </button>
            </div>
          </div>
        ) : null}

        {!isLiveStream && activeTab === "body" ? (
          <div className={`req-panel active${bodyFill ? " req-panel--fill" : ""}`}>
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
                  key="http-json-body"
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

        {!isLiveStream && activeTab === "auth" ? (
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
                    {t(`protocol.http.authTypes.${AUTH_TYPE_I18N_KEYS[auth]}`)}
                  </span>
                ))}
              </div>
              <div className="kv-editor">
                <div className="kv-row">
                  <TextInput
                    placeholder={
                      authType === "Authorization"
                        ? t("protocol.http.authAuthorizationPlaceholder")
                        : t("protocol.http.token")
                    }
                    value={authValue}
                    onChange={setAuthValue}
                    style={{ flex: 3 }}
                  />
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {!isLiveStream && activeTab === "scripts" ? (
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
    return <div className="http-editor-shell">{editorContent}</div>;
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
