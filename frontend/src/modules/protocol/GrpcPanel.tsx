import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

interface GrpcCallResponse {
  response_json: string;
  status_code: number;
  grpc_status: number;
  headers: [string, string][];
  duration_ms: number;
}

interface CallHistoryEntry {
  method: string;
  request: string;
  response: string;
  status: number;
  grpcStatus: number;
  durationMs: number;
  timestamp: Date;
}

export function GrpcPanel() {
  const [endpoint, setEndpoint] = useState("http://localhost:50051");
  const [connectionId, setConnectionId] = useState("");
  const [method, setMethod] = useState("");
  const [requestJson, setRequestJson] = useState("{}");
  const [metadata, setMetadata] = useState("");
  const [response, setResponse] = useState<GrpcCallResponse | null>(null);
  const [history, setHistory] = useState<CallHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);

  const handleConnect = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const metaObj: Record<string, string> = {};
      if (metadata) {
        metadata.split(",").forEach((pair) => {
          const [k, v] = pair.split("=").map((s) => s.trim());
          if (k && v) metaObj[k] = v;
        });
      }
      const id = await invoke<string>("grpc_connect", {
        config: { endpoint, metadata: Object.entries(metaObj), useTls: endpoint.startsWith("https") },
      });
      setConnectionId(id);
      setConnected(true);
    } catch (e: any) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [endpoint, metadata]);

  const handleDisconnect = useCallback(async () => {
    if (connectionId) {
      try { await invoke("grpc_close", { connectionId }); } catch {}
    }
    setConnected(false);
    setConnectionId("");
    setResponse(null);
  }, [connectionId]);

  const handleCall = useCallback(async () => {
    if (!connectionId || !method) return;
    setLoading(true);
    setError("");
    try {
      const metaObj: Record<string, string> = {};
      if (metadata) {
        metadata.split(",").forEach((pair) => {
          const [k, v] = pair.split("=").map((s) => s.trim());
          if (k && v) metaObj[k] = v;
        });
      }
      const resp = await invoke<GrpcCallResponse>("grpc_call", {
        connectionId,
        request: { method, requestJson, metadata: Object.entries(metaObj) },
      });
      setResponse(resp);
      setHistory((prev) => [
        { method, request: requestJson, response: resp.response_json, status: resp.status_code, grpcStatus: resp.grpc_status, durationMs: resp.duration_ms, timestamp: new Date() },
        ...prev.slice(0, 49),
      ]);
    } catch (e: any) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [connectionId, method, requestJson, metadata]);

  return (
    <div style={{ height: "100%", display: "flex" }}>
      {/* Main panel */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: 16, gap: 12, overflow: "auto" }}>
        <h3 style={{ margin: 0 }}>gRPC 调试</h3>

        {/* Connection */}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input className="input" placeholder="gRPC 端点 (http://host:port)" value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)} style={{ flex: 1 }} disabled={connected} />
          <input className="input" placeholder="Metadata (k1=v1,k2=v2)" value={metadata}
            onChange={(e) => setMetadata(e.target.value)} style={{ width: 200 }} disabled={connected} />
          {!connected ? (
            <button className="btn btn-primary" onClick={handleConnect} disabled={loading}>连接</button>
          ) : (
            <button className="btn btn-danger" onClick={handleDisconnect}>断开</button>
          )}
        </div>

        {connected && (
          <>
            {/* Method & Request */}
            <div style={{ display: "flex", gap: 8 }}>
              <input className="input" placeholder="方法路径 (package.Service/Method)" value={method}
                onChange={(e) => setMethod(e.target.value)} style={{ flex: 1 }} />
              <button className="btn btn-primary" onClick={handleCall} disabled={loading || !method}>
                {loading ? "调用中..." : "发送"}
              </button>
            </div>

            <div style={{ display: "flex", gap: 12, flex: 1, minHeight: 0 }}>
              {/* Request editor */}
              <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
                <label style={{ fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>请求 JSON</label>
                <textarea className="input" value={requestJson} onChange={(e) => setRequestJson(e.target.value)}
                  style={{ flex: 1, fontFamily: "monospace", fontSize: 12, resize: "none" }} />
              </div>

              {/* Response viewer */}
              <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
                <label style={{ fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>
                  响应 {response && `(HTTP ${response.status_code} | gRPC ${response.grpc_status} | ${response.duration_ms}ms)`}
                </label>
                <pre style={{
                  flex: 1, background: "var(--bg-secondary)", padding: 12, borderRadius: 6,
                  fontSize: 12, overflow: "auto", margin: 0, fontFamily: "monospace",
                }}>
                  {response ? tryFormatJson(response.response_json) : "等待调用..."}
                </pre>
              </div>
            </div>
          </>
        )}

        {error && <div style={{ color: "var(--danger)", fontSize: 12, padding: "4px 0" }}>{error}</div>}

        {!connected && (
          <div style={{ textAlign: "center", padding: 40, color: "var(--muted)" }}>
            输入 gRPC 服务器地址并点击「连接」开始调试
          </div>
        )}
      </div>

      {/* History sidebar */}
      {history.length > 0 && (
        <div style={{ width: 240, borderLeft: "1px solid var(--border)", overflow: "auto", padding: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, padding: "4px 8px", color: "var(--muted)" }}>历史记录</div>
          {history.map((h, i) => (
            <div key={i} style={{ padding: "6px 8px", cursor: "pointer", borderRadius: 4, fontSize: 11 }}
              onClick={() => { setMethod(h.method); setRequestJson(h.request); }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "")}>
              <div style={{ fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {h.method}
              </div>
              <div style={{ color: "var(--muted)", fontSize: 10, marginTop: 2 }}>
                {h.grpcStatus === 0 ? "✅" : "❌"} {h.durationMs}ms · {h.timestamp.toLocaleTimeString()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function tryFormatJson(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2); }
  catch { return s; }
}
