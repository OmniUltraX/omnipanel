import { useState, type FormEvent } from "react";
import { WorkbenchPanelHeader, WorkbenchActionButton } from "../ui/primitives";
import { webLogin, webLogout } from "../../ipc/webAuth";

/** Separate server-access gate: do not confuse it with the optional OmniPanel cloud account. */
export function WebLogin({ onAuthenticated, initialError = "" }: { onAuthenticated: () => void; initialError?: string }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { await webLogin(key); setKey(""); onAuthenticated(); }
    catch (e) { setError(e instanceof Error ? e.message : "Authentication failed"); }
    finally { setBusy(false); }
  }
  return <main style={{ maxWidth: 460, margin: "12vh auto", padding: 24 }}>
    <WorkbenchPanelHeader label="OmniPanel Web · 服务器访问 / Server access" />
    <form onSubmit={(event) => { void submit(event); }} style={{ display: "grid", gap: 16, paddingTop: 24 }}>
      <p>输入部署时设置的 API Key。密钥不会写入页面、URL 或浏览器存储。</p>
      <p>Enter the deployment API key. Access uses an expiring HttpOnly session cookie.</p>
      <label htmlFor="web-api-key">API Key</label>
      <input id="web-api-key" type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} autoFocus required style={{ padding: 10, border: "1px solid var(--border-color, #666)", background: "transparent" }} />
      {error && <p role="alert">{error}</p>}
      <WorkbenchActionButton type="submit" disabled={busy || !key}>{busy ? "验证中 / Checking…" : "解锁 / Unlock"}</WorkbenchActionButton>
    </form>
  </main>;
}
export function WebSessionLock() {
  const [error, setError] = useState("");
  return <div style={{ position: "fixed", bottom: 4, right: 8, zIndex: 10000 }}>
    {error && <span role="alert">{error}</span>}
    <WorkbenchActionButton onClick={() => { void webLogout().catch(() => setError("锁定失败 / Lock failed")); }}>锁定 Web / Lock</WorkbenchActionButton>
  </div>;
}
