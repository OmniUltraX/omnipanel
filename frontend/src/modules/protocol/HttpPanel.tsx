import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../i18n";
import { Select } from "../../components/ui/Select";
import { SidebarSecondary } from "../../components/ui/SidebarSecondary";

interface KVPair {
  key: string;
  value: string;
  enabled: boolean;
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
type BodyType = "JSON" | "Form" | "Multipart" | "Raw" | "Binary";
type AuthType = "Bearer Token" | "Basic Auth" | "API Key" | "OAuth 2.0";
type ReqTab = "params" | "headers" | "body" | "auth" | "scripts";
type SideTab = "history" | "collections";

const AUTH_TYPE_KEYS: Record<AuthType, "bearerToken" | "basicAuth" | "apiKey" | "oauth2"> = {
  "Bearer Token": "bearerToken",
  "Basic Auth": "basicAuth",
  "API Key": "apiKey",
  "OAuth 2.0": "oauth2",
};

interface HttpResponse {
  status: number;
  status_text: string;
  time_ms: number;
  size_bytes: number;
  content_type: string;
  body: string;
  headers: Record<string, string>;
}

interface SavedHttpRequest {
  id: string;
  name: string;
  method: string;
  url: string;
  headers: string;
  body: string;
  authType: string;
  authValue: string;
  collectionId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface HttpHistoryEntry {
  id: string;
  method: string;
  url: string;
  statusCode: number | null;
  responseTimeMs: number | null;
  requestSize: number | null;
  responseSize: number | null;
  createdAt: number;
}

interface HttpCollection {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function methodColor(method: string): string {
  const m = method.toUpperCase();
  if (m === "GET") return "var(--success, #4caf50)";
  if (m === "POST") return "var(--warning, #ff9800)";
  if (m === "PUT") return "var(--info, #2196f3)";
  if (m === "PATCH") return "var(--info, #9c27b0)";
  if (m === "DELETE") return "var(--danger, #f44336)";
  return "var(--text-dim)";
}

export function HttpPanel() {
  const { t } = useI18n();
  const [method, setMethod] = useState<HttpMethod>("GET");
  const [url, setUrl] = useState("https://api.example.com/v1/users");
  const [activeTab, setActiveTab] = useState<ReqTab>("params");
  const [bodyType, setBodyType] = useState<BodyType>("JSON");
  const [authType, setAuthType] = useState<AuthType>("Bearer Token");
  const [sending, setSending] = useState(false);

  const [params, setParams] = useState<KVPair[]>([
    { key: "page", value: "1", enabled: true },
    { key: "limit", value: "20", enabled: true },
    { key: "sort", value: "created_at", enabled: false },
  ]);

  const [headers, setHeaders] = useState<KVPair[]>([
    { key: "Content-Type", value: "application/json", enabled: true },
    { key: "Authorization", value: "Bearer eyJhbG...token", enabled: true },
    { key: "Accept", value: "application/json", enabled: true },
  ]);

  const [body, setBody] = useState(
    '{\n  "name": "John Doe",\n  "email": "john@example.com",\n  "role": "admin"\n}'
  );

  const [response, setResponse] = useState<HttpResponse | null>(null);

  // ─── Sidebar state ───
  const [sideTab, setSideTab] = useState<SideTab>("history");
  const [history, setHistory] = useState<HttpHistoryEntry[]>([]);
  const [collections, setCollections] = useState<HttpCollection[]>([]);
  const [savedRequests, setSavedRequests] = useState<SavedHttpRequest[]>([]);
  const [activeCollectionId, setActiveCollectionId] = useState<string | null>(null);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [showNewCollection, setShowNewCollection] = useState(false);
  const [saveRequestName, setSaveRequestName] = useState("");
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  // ─── Load history & collections ───
  const loadHistory = useCallback(async () => {
    try {
      const items = await invoke<HttpHistoryEntry[]>("http_list_history", { limit: 100 });
      setHistory(items);
    } catch { /* ignore */ }
  }, []);

  const loadCollections = useCallback(async () => {
    try {
      const cols = await invoke<HttpCollection[]>("http_list_collections");
      setCollections(cols);
    } catch { /* ignore */ }
  }, []);

  const loadSavedRequests = useCallback(async (collectionId: string | null) => {
    try {
      const reqs = await invoke<SavedHttpRequest[]>("http_list_requests", { collectionId });
      setSavedRequests(reqs);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadHistory();
    loadCollections();
  }, [loadHistory, loadCollections]);

  useEffect(() => {
    loadSavedRequests(activeCollectionId);
  }, [activeCollectionId, loadSavedRequests]);

  // ─── History actions ───
  const clearHistory = async () => {
    try {
      await invoke("http_clear_history");
      setHistory([]);
    } catch { /* ignore */ }
  };

  const clickHistory = (entry: HttpHistoryEntry) => {
    setMethod(entry.method as HttpMethod);
    setUrl(entry.url);
  };

  // ─── Collection actions ───
  const createCollection = async () => {
    if (!newCollectionName.trim()) return;
    const now = Date.now();
    const col: HttpCollection = {
      id: generateId(),
      name: newCollectionName.trim(),
      description: "",
      createdAt: now,
      updatedAt: now,
    };
    try {
      await invoke("http_save_collection", { col });
      setNewCollectionName("");
      setShowNewCollection(false);
      loadCollections();
    } catch { /* ignore */ }
  };

  const deleteCollection = async (id: string) => {
    try {
      await invoke("http_delete_collection", { id });
      if (activeCollectionId === id) setActiveCollectionId(null);
      loadCollections();
    } catch { /* ignore */ }
  };

  // ─── Save request to collection ───
  const handleSaveRequest = async () => {
    if (!saveRequestName.trim()) return;
    const now = Date.now();
    const enabledHeaders = headers.filter((h) => h.enabled && h.key);
    const headerMap: Record<string, string> = {};
    for (const h of enabledHeaders) headerMap[h.key] = h.value;

    const req: SavedHttpRequest = {
      id: generateId(),
      name: saveRequestName.trim(),
      method,
      url,
      headers: JSON.stringify(headerMap),
      body,
      authType: authType === "Bearer Token" ? "bearer" : "",
      authValue: "",
      collectionId: activeCollectionId,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await invoke("http_save_request", { req });
      setSaveRequestName("");
      setShowSaveDialog(false);
      loadSavedRequests(activeCollectionId);
    } catch { /* ignore */ }
  };

  const clickSavedRequest = (req: SavedHttpRequest) => {
    setMethod(req.method as HttpMethod);
    setUrl(req.url);
    setBody(req.body);
    if (req.headers) {
      try {
        const map = JSON.parse(req.headers);
        const newHeaders = Object.entries(map).map(([key, value]) => ({
          key,
          value: value as string,
          enabled: true,
        }));
        if (newHeaders.length > 0) setHeaders(newHeaders);
      } catch { /* ignore */ }
    }
  };

  const deleteSavedRequest = async (id: string) => {
    try {
      await invoke("http_delete_request", { id });
      loadSavedRequests(activeCollectionId);
    } catch { /* ignore */ }
  };

  const updateKv = (
    list: KVPair[],
    setList: (v: KVPair[]) => void,
    idx: number,
    field: keyof KVPair,
    value: string | boolean
  ) => {
    const next = [...list];
    next[idx] = { ...next[idx], [field]: value };
    setList(next);
  };

  const removeKv = (list: KVPair[], setList: (v: KVPair[]) => void, idx: number) => {
    setList(list.filter((_, i) => i !== idx));
  };

  const addKv = (list: KVPair[], setList: (v: KVPair[]) => void) => {
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

      const config = {
        method,
        url,
        headers: headerMap,
        query_params: queryParams,
        body: bodyType !== "Binary" ? body : null,
        body_type: bodyType.toLowerCase(),
        auth_type: authType === "Bearer Token" ? "Bearer Token" : null,
        auth_value: authType === "Bearer Token" ? headers.find((h) => h.key === "Authorization")?.value.replace("Bearer ", "") : null,
        timeout_ms: 30000,
      };

      const result = await invoke<HttpResponse>("http_request", { config });
      setResponse(result);

      // Record to history
      const entry: HttpHistoryEntry = {
        id: generateId(),
        method,
        url,
        statusCode: result.status,
        responseTimeMs: result.time_ms,
        requestSize: body ? new TextEncoder().encode(body).length : 0,
        responseSize: result.size_bytes,
        createdAt: Date.now(),
      };
      try {
        await invoke("http_add_history", { entry });
        loadHistory();
      } catch { /* ignore */ }
    } catch (e) {
      setResponse({
        status: 0,
        status_text: "Error",
        time_ms: 0,
        size_bytes: 0,
        content_type: "text/plain",
        body: String(e),
        headers: {},
      });
    } finally {
      setSending(false);
    }
  }, [method, url, params, headers, body, bodyType, authType, loadHistory]);

  const tabs: ReqTab[] = ["params", "headers", "body", "auth", "scripts"];

  const sidebarContent = (
    <>
      {/* Side tabs */}
      <div className="proto-sidebar-header">
        <button
          onClick={() => setSideTab("history")}
          className={`proto-tab-btn${sideTab === "history" ? " is-active" : ""}`}
        >
          {t("protocol.http.history") || "History"}
        </button>
        <button
          onClick={() => setSideTab("collections")}
          className={`proto-tab-btn${sideTab === "collections" ? " is-active" : ""}`}
        >
          {t("protocol.http.collections") || "Collections"}
        </button>
      </div>

      {/* History list */}
      {sideTab === "history" && (
        <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "6px 8px", display: "flex", justifyContent: "flex-end", flexShrink: 0 }}>
            <button onClick={clearHistory} className="proto-link-danger">
              {t("protocol.http.clearHistory") || "Clear"}
            </button>
          </div>
          {history.length === 0 && (
            <div className="proto-empty">
              {t("protocol.http.noHistory") || "No history yet"}
            </div>
          )}
          {history.map((entry) => (
            <div key={entry.id} onClick={() => clickHistory(entry)} className="history-item">
              <div className="history-item-main">
                <span className="h-method" style={{ color: methodColor(entry.method) }}>
                  {entry.method}
                </span>
                <span className="h-url">{entry.url}</span>
              </div>
              <div className="history-item-meta">
                {entry.statusCode && (
                  <span className={`h-status ${entry.statusCode < 400 ? "h-status-ok" : "h-status-err"}`}>
                    {entry.statusCode}
                  </span>
                )}
                {entry.responseTimeMs != null && (
                  <span className="h-time">{entry.responseTimeMs}ms</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Collections list */}
      {sideTab === "collections" && (
        <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "6px 8px", display: "flex", gap: "4px", flexShrink: 0 }}>
            {showNewCollection ? (
              <div style={{ display: "flex", gap: "4px", width: "100%" }}>
                <input
                  value={newCollectionName}
                  onChange={(e) => setNewCollectionName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && createCollection()}
                  placeholder={t("protocol.http.collectionName") || "Name..."}
                  className="proto-input-sm"
                  autoFocus
                />
                <button onClick={createCollection} className="proto-icon-btn-accent">✓</button>
                <button onClick={() => { setShowNewCollection(false); setNewCollectionName(""); }} className="proto-icon-btn">✕</button>
              </div>
            ) : (
              <button onClick={() => setShowNewCollection(true)} className="proto-sidebar-action" style={{ width: "100%", justifyContent: "center" }}>
                + {t("protocol.http.newCollection") || "New Collection"}
              </button>
            )}
          </div>

          <div
            onClick={() => setActiveCollectionId(null)}
            className={`proto-context-item${activeCollectionId === null ? " is-active" : ""}`}
          >
            📁 {t("protocol.http.allRequests") || "All Requests"}
          </div>

          {collections.map((col) => (
            <div key={col.id}>
              <div
                onClick={() => setActiveCollectionId(col.id)}
                className={`proto-context-item${activeCollectionId === col.id ? " is-active" : ""}`}
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  📁 {col.name}
                </span>
                <span
                  onClick={(e) => { e.stopPropagation(); deleteCollection(col.id); }}
                  className="proto-delete-btn"
                >
                  ✕
                </span>
              </div>
            </div>
          ))}

          {savedRequests.length > 0 && (
            <div style={{ borderTop: "1px solid var(--border)", marginTop: "4px" }}>
              <div style={{ padding: "6px 10px", fontSize: "11px", color: "var(--meta)", fontWeight: 600 }}>
                {t("protocol.http.savedRequests") || "Saved Requests"} ({savedRequests.length})
              </div>
              {savedRequests.map((req) => (
                <div
                  key={req.id}
                  onClick={() => clickSavedRequest(req)}
                  className="history-item"
                >
                  <div className="history-item-main">
                    <span className="h-method" style={{ color: methodColor(req.method) }}>
                      {req.method}
                    </span>
                    <span className="h-url">{req.name}</span>
                  </div>
                  <span
                    onClick={(e) => { e.stopPropagation(); deleteSavedRequest(req.id); }}
                    className="proto-delete-btn"
                  >
                    ✕
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );

  return (
    <SidebarSecondary sidebar={sidebarContent} className="http-panel" sidebarSizePx={240} sidebarMinPx={180}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "auto", padding: "var(--sp-3)" }}>
        {/* Request builder */}
        <div className="http-builder">
          <Select
            className="method-select"
            value={method}
            onChange={(v) => setMethod(v as HttpMethod)}
            searchable={false}
            options={["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]}
          />
          <input
            className="url-input"
            placeholder={t("protocol.http.urlPlaceholder")}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button className="btn btn-primary" onClick={handleSend} disabled={sending}>
            {sending ? t("protocol.common.sending") : t("protocol.common.send")}
          </button>
          <button className="btn btn-secondary" onClick={() => setShowSaveDialog(true)}>
            {t("protocol.common.save")}
          </button>
        </div>

        {/* Save request dialog */}
        {showSaveDialog && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              padding: "6px 0",
              marginTop: "4px",
            }}
          >
            <input
              value={saveRequestName}
              onChange={(e) => setSaveRequestName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSaveRequest()}
              placeholder={t("protocol.http.requestName") || "Request name..."}
              style={{
                flex: 1,
                fontSize: "12px",
                padding: "4px 8px",
                background: "var(--bg-input)",
                border: "1px solid var(--border)",
                borderRadius: "4px",
                color: "var(--text)",
                outline: "none",
              }}
              autoFocus
            />
            {activeCollectionId && (
              <span style={{ fontSize: "11px", color: "var(--text-dim)" }}>
                → {collections.find((c) => c.id === activeCollectionId)?.name}
              </span>
            )}
            <button className="btn btn-primary btn-sm" onClick={handleSaveRequest}>
              {t("protocol.common.save") || "Save"}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => { setShowSaveDialog(false); setSaveRequestName(""); }}
            >
              {t("protocol.common.cancel") || "Cancel"}
            </button>
          </div>
        )}

        {/* Request tabs */}
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

        {/* Params panel */}
        {activeTab === "params" && (
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
        )}

        {/* Headers panel */}
        {activeTab === "headers" && (
          <div className="req-panel active">
            <div className="kv-editor">
              {headers.map((h, i) => (
                <div className="kv-row" key={i}>
                  <input
                    type="checkbox"
                    className="kv-check"
                    checked={h.enabled}
                    onChange={(e) => updateKv(headers, setHeaders, i, "enabled", e.target.checked)}
                  />
                  <input
                    placeholder={t("protocol.common.key")}
                    value={h.key}
                    onChange={(e) => updateKv(headers, setHeaders, i, "key", e.target.value)}
                  />
                  <input
                    placeholder={t("protocol.common.value")}
                    value={h.value}
                    onChange={(e) => updateKv(headers, setHeaders, i, "value", e.target.value)}
                  />
                  <div className="kv-del" onClick={() => removeKv(headers, setHeaders, i)}>
                    {"×"}
                  </div>
                </div>
              ))}
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => addKv(headers, setHeaders)}>
              + {t("protocol.common.addHeader")}
            </button>
          </div>
        )}

        {/* Body panel */}
        {activeTab === "body" && (
          <div className="req-panel active">
            <div style={{ marginBottom: "var(--sp-2)", display: "flex", gap: "var(--sp-2)" }}>
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
            <textarea
              className="body-editor"
              placeholder={t("protocol.http.requestBody")}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
        )}

        {/* Auth panel */}
        {activeTab === "auth" && (
          <div className="req-panel active">
            <div style={{ marginBottom: "var(--sp-3)" }}>
              <div style={{ display: "flex", gap: "var(--sp-2)", marginBottom: "var(--sp-3)" }}>
                {(["Bearer Token", "Basic Auth", "API Key", "OAuth 2.0"] as AuthType[]).map(
                  (auth) => (
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
                  )
                )}
              </div>
              <div className="kv-editor">
                <div className="kv-row">
                  <input
                    placeholder={t("protocol.http.token")}
                    defaultValue="eyJhbG...VCJ9..."
                    style={{ flex: 3 }}
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Scripts panel */}
        {activeTab === "scripts" && (
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
        )}

        {/* Response area */}
        {response && (
          <div className="response-area" style={{ marginTop: "var(--sp-4)" }}>
            <div className="response-header">
              <span
                className={`response-status ${
                  response.status >= 200 && response.status < 400 ? "badge-success" : "badge-danger"
                }`}
              >
                {response.status} {response.status_text}
              </span>
              <span className="response-meta">
                {response.time_ms}ms {"·"} {(response.size_bytes / 1024).toFixed(1)} KB
              </span>
              <span className="response-meta">{"·"}</span>
              <span className="response-meta">{response.content_type}</span>
            </div>
            <div className="response-body">{response.body}</div>
          </div>
        )}
      </div>
    </SidebarSecondary>
  );
}
