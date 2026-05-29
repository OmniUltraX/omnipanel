import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../i18n";

interface KVPair {
  key: string;
  value: string;
  enabled: boolean;
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
type BodyType = "JSON" | "Form" | "Multipart" | "Raw" | "Binary";
type AuthType = "Bearer Token" | "Basic Auth" | "API Key" | "OAuth 2.0";
type ReqTab = "params" | "headers" | "body" | "auth" | "scripts";

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
  }, [method, url, params, headers, body, bodyType, authType]);

  const tabs: ReqTab[] = ["params", "headers", "body", "auth", "scripts"];

  return (
    <div className="http-panel">
      {/* Request builder */}
      <div className="http-builder">
        <select
          className="method-select"
          value={method}
          onChange={(e) => setMethod(e.target.value as HttpMethod)}
        >
          {(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as HttpMethod[]).map(
            (m) => (
              <option key={m} value={m}>
                {m}
              </option>
            )
          )}
        </select>
        <input
          className="url-input"
          placeholder={t("protocol.http.urlPlaceholder")}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button className="btn btn-primary" onClick={handleSend} disabled={sending}>
          {sending ? t("protocol.common.sending") : t("protocol.common.send")}
        </button>
        <button className="btn btn-secondary">{t("protocol.common.save")}</button>
      </div>

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
                  defaultValue="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
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
  );
}
