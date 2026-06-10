import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FormDialog } from "../../components/ui/FormDialog";
import { Select } from "../../components/ui/Select";
import { useConnectionStore } from "../../stores/connectionStore";
import { sanitizeSshGroupInput } from "../../lib/sshGroups";
import type { Connection } from "../../ipc/bindings";

/** Backend type from docker_probe_ssh_docker */
interface DockerAutoDetectResult {
  available: boolean;
  version?: string;
  os?: string;
  containers: number;
  images: number;
  error?: string;
}

/** Backend type from docker_list_ssh_hosts */
interface SshHostInfo {
  connectionId: string;
  name: string;
  host: string;
  port: number;
  user: string;
}

interface DockerConnectionDialogProps {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
  editConnection?: Connection;
}

type Source = "local-engine" | "remote-engine" | "ssh-engine" | "onepanel";
type SshAuth = "password" | "privateKey";
type TlsMode = "none" | "tls";

interface DockerForm {
  name: string;
  group: string;
  envTag: string;
  source: Source;
  remoteHost: string;
  remotePort: string;
  tlsMode: TlsMode;
  caCert: string;
  clientCert: string;
  clientKey: string;
  sshHost: string;
  sshPort: string;
  sshUser: string;
  sshAuth: SshAuth;
  sshPassword: string;
  sshPem: string;
  sshPassphrase: string;
  boundSshConnectionId: string;
  panelBaseUrl: string;
  panelApiKey: string;
  panelInsecure: boolean;
}

const ENV_OPTIONS: { value: string; label: string }[] = [
  { value: "local", label: "本地" },
  { value: "dev", label: "开发" },
  { value: "staging", label: "预发" },
  { value: "prod", label: "生产" },
  { value: "unknown", label: "未标记" },
];

const EMPTY: DockerForm = {
  name: "",
  group: "默认",
  envTag: "local",
  source: "local-engine",
  remoteHost: "",
  remotePort: "2376",
  tlsMode: "tls",
  caCert: "",
  clientCert: "",
  clientKey: "",
  sshHost: "",
  sshPort: "22",
  sshUser: "root",
  sshAuth: "password",
  sshPassword: "",
  sshPem: "",
  sshPassphrase: "",
  boundSshConnectionId: "",
  panelBaseUrl: "",
  panelApiKey: "",
  panelInsecure: false,
};

function formToConfig(form: DockerForm): string {
  if (form.source === "local-engine") {
    return JSON.stringify({ source: "local-engine" });
  }
  if (form.source === "onepanel") {
    return formToOnePanelConfig(form);
  }
  if (form.source === "remote-engine") {
    const cfg: Record<string, unknown> = {
      source: "remote-engine",
      host: form.remoteHost.trim(),
      port: parseInt(form.remotePort, 10) || 2376,
    };
    if (form.tlsMode === "tls") {
      cfg.tls = true;
      if (form.caCert.trim()) cfg.caCert = form.caCert;
      if (form.clientCert.trim()) cfg.clientCert = form.clientCert;
      if (form.clientKey.trim()) cfg.clientKey = form.clientKey;
    } else {
      cfg.tls = false;
    }
    return JSON.stringify(cfg);
  }
  // ssh-engine
  const auth =
    form.sshAuth === "password"
      ? { type: "password", password: form.sshPassword }
      : { type: "privateKey", pem: form.sshPem, passphrase: form.sshPassphrase || null };
  const cfg: Record<string, unknown> = {
    source: "ssh-engine",
    host: `${form.sshUser}@${form.sshHost}:${parseInt(form.sshPort, 10) || 22}`,
    ssh: {
      host: form.sshHost.trim(),
      port: parseInt(form.sshPort, 10) || 22,
      user: form.sshUser.trim(),
      auth,
    },
  };
  if (form.boundSshConnectionId.trim()) {
    cfg.boundSshConnectionId = form.boundSshConnectionId.trim();
  }
  return JSON.stringify(cfg);
}

function formToOnePanelConfig(form: DockerForm): string {
  const cfg: Record<string, unknown> = {
    source: "onepanel",
    host: form.panelBaseUrl.trim(),
    onepanel: {
      baseUrl: form.panelBaseUrl.trim(),
      apiKey: form.panelApiKey,
      insecure: form.panelInsecure,
    },
  };
  return JSON.stringify(cfg);
}

function connectionToForm(conn: Connection): DockerForm {
  const base: DockerForm = { ...EMPTY, name: conn.name, group: conn.group || "默认", envTag: conn.envTag || "local" };
  let cfg: Record<string, unknown> = {};
  try {
    cfg = conn.config ? (JSON.parse(conn.config) as Record<string, unknown>) : {};
  } catch {
    /* ignore */
  }
  const source = typeof cfg.source === "string" ? cfg.source : "local-engine";
  if (source === "remote-engine") {
    base.source = "remote-engine";
    if (typeof cfg.host === "string") base.remoteHost = cfg.host;
    if (typeof cfg.port === "number") base.remotePort = String(cfg.port);
    if (cfg.tls === true) {
      base.tlsMode = "tls";
      if (typeof cfg.caCert === "string") base.caCert = cfg.caCert;
      if (typeof cfg.clientCert === "string") base.clientCert = cfg.clientCert;
      if (typeof cfg.clientKey === "string") base.clientKey = cfg.clientKey;
    } else {
      base.tlsMode = "none";
    }
  } else if (source === "ssh-engine") {
    base.source = "ssh-engine";
    const ssh = cfg.ssh as Record<string, unknown> | undefined;
    if (ssh) {
      if (typeof ssh.host === "string") base.sshHost = ssh.host;
      if (typeof ssh.port === "number") base.sshPort = String(ssh.port);
      if (typeof ssh.user === "string") base.sshUser = ssh.user;
      const auth = ssh.auth as Record<string, unknown> | undefined;
      if (auth) {
        if (auth.type === "privateKey") {
          base.sshAuth = "privateKey";
          if (typeof auth.pem === "string") base.sshPem = auth.pem;
          if (typeof auth.passphrase === "string") base.sshPassphrase = auth.passphrase;
        } else {
          base.sshAuth = "password";
          if (typeof auth.password === "string") base.sshPassword = auth.password;
        }
      }
    }
    if (typeof cfg.boundSshConnectionId === "string") {
      base.boundSshConnectionId = cfg.boundSshConnectionId;
    }
  } else if (source === "onepanel") {
    base.source = "onepanel";
    const panel = cfg.onepanel as Record<string, unknown> | undefined;
    if (panel) {
      if (typeof panel.baseUrl === "string") base.panelBaseUrl = panel.baseUrl;
      if (typeof panel.apiKey === "string") base.panelApiKey = panel.apiKey;
      if (panel.insecure === true) base.panelInsecure = true;
    }
  }
  return base;
}

export function DockerConnectionDialog({
  open,
  onClose,
  onSaved,
  editConnection,
}: DockerConnectionDialogProps) {
  const saveConn = useConnectionStore((s) => s.save);
  const connections = useConnectionStore((s) => s.connections);

  const [form, setForm] = useState<DockerForm>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectedHosts, setConnectedHosts] = useState<SshHostInfo[]>([]);
  const [detectResult, setDetectResult] = useState<DockerAutoDetectResult | null>(null);
  const [detecting, setDetecting] = useState(false);

  const sshConnections = useMemo(
    () => connections.filter((c) => c.kind === "ssh"),
    [connections]
  );

  const isEdit = !!editConnection?.id;

  /** Load connected SSH hosts when dialog opens in ssh-engine mode */
  const loadSshHosts = useCallback(async () => {
    try {
      const hosts = await invoke<SshHostInfo[]>("docker_list_ssh_hosts");
      setConnectedHosts(hosts);
    } catch {
      setConnectedHosts([]);
    }
  }, []);

  /** Probe selected SSH host for Docker daemon */
  const handleDetectDocker = useCallback(async (sshConnectionId: string) => {
    if (!sshConnectionId) return;
    setDetecting(true);
    setDetectResult(null);
    try {
      const result = await invoke<DockerAutoDetectResult>("docker_probe_ssh_docker", {
        sshConnectionId,
      });
      setDetectResult(result);
    } catch (e) {
      setDetectResult({ available: false, containers: 0, images: 0, error: String(e) });
    } finally {
      setDetecting(false);
    }
  }, []);

  /** Quick-fill from a connected SSH host */
  const handleUseSshHost = useCallback((host: SshHostInfo) => {
    setForm((prev) => ({
      ...prev,
      sshHost: host.host,
      sshPort: String(host.port),
      sshUser: host.user,
      boundSshConnectionId: host.connectionId,
    }));
    setDetectResult(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    if (editConnection) {
      setForm(connectionToForm(editConnection));
    } else {
      setForm(EMPTY);
    }
    setError(null);
    setSaving(false);
    setDetectResult(null);
    setDetecting(false);
    loadSshHosts();
  }, [open, editConnection, loadSshHosts]);

  if (!open) return null;

  const update = <K extends keyof DockerForm>(key: K, value: DockerForm[K]) => {
    setError(null);
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const validate = (): string | null => {
    if (!form.name.trim()) return "请输入连接名称";
    if (form.source === "remote-engine" && !form.remoteHost.trim()) return "请输入远程 Engine 地址";
    if (form.source === "ssh-engine") {
      if (!form.sshHost.trim()) return "请输入 SSH 主机";
      if (!form.sshUser.trim()) return "请输入 SSH 用户名";
      if (form.sshAuth === "password" && !form.sshPassword.trim()) return "请输入 SSH 密码";
      if (form.sshAuth === "privateKey" && !form.sshPem.trim()) return "请输入 SSH 私钥";
    }
    if (form.source === "onepanel") {
      if (!form.panelBaseUrl.trim()) return "请输入 1Panel 面板地址";
      if (!form.panelApiKey.trim()) return "请输入 1Panel API Key";
    }
    return null;
  };

  const handleSave = async () => {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const conn: Connection = {
        id: editConnection?.id ?? "",
        kind: "docker",
        name: form.name.trim(),
        group: sanitizeSshGroupInput(form.group),
        envTag: form.envTag,
        config: formToConfig(form),
      };
      const saved = await saveConn(conn);
      if (!saved) {
        setError("保存失败");
        return;
      }
      onSaved?.();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={isEdit ? "编辑 Docker 连接" : "添加 Docker 连接"}
      size="lg"
      onCancel={onClose}
      cancelDisabled={saving}
      status={error ? { kind: "error", message: error } : null}
      primaryAction={{
        label: saving ? "保存中…" : "保存",
        disabled: saving,
        onClick: () => void handleSave(),
      }}
    >
          <div className="form-field">
            <label className="form-label">连接名称</label>
            <input
              className="input"
              placeholder="例如：本地 Docker / 生产 K8s 节点 / 192.168.1.10"
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
              style={{ width: "100%" }}
            />
          </div>

          <div className="form-field">
            <label className="form-label">引擎来源</label>
            <div className="engine-grid" style={{ gridTemplateColumns: "1fr 1fr 1fr 1fr" }}>
              {(
                [
                  { value: "local-engine" as const, label: "本地 Engine", hint: "本机 Docker Desktop / Engine" },
                  { value: "remote-engine" as const, label: "远程 Engine", hint: "Docker Engine API (TCP/TLS)" },
                  { value: "ssh-engine" as const, label: "SSH 宿主机", hint: "在远端调用 docker CLI" },
                  { value: "onepanel" as const, label: "1Panel 面板", hint: "通过 /api/v2 调用" },
                ]
              ).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`engine-chip${form.source === opt.value ? " engine-chip--active" : ""}`}
                  onClick={() => update("source", opt.value)}
                >
                  <div className="engine-chip-title">{opt.label}</div>
                  <div className="engine-chip-hint">{opt.hint}</div>
                </button>
              ))}
            </div>
          </div>

          {form.source === "local-engine" && (
            <div className="form-hint" style={{ marginTop: 4 }}>
              将使用本机 Docker Desktop / Engine 默认连接（Unix socket 或 Windows 命名管道）。无需额外配置。
            </div>
          )}

          {form.source === "remote-engine" && (
            <>
              <div className="form-row">
                <div className="form-field" style={{ flex: 2 }}>
                  <label className="form-label">Engine 地址</label>
                  <input
                    className="input"
                    placeholder="docker.example.com"
                    value={form.remoteHost}
                    onChange={(e) => update("remoteHost", e.target.value)}
                    style={{ width: "100%" }}
                  />
                </div>
                <div className="form-field" style={{ flex: 1 }}>
                  <label className="form-label">端口</label>
                  <input
                    className="input"
                    placeholder="2376"
                    value={form.remotePort}
                    onChange={(e) => update("remotePort", e.target.value)}
                    style={{ width: "100%" }}
                  />
                </div>
              </div>

              <div className="form-field">
                <label className="form-label">TLS</label>
                <div className="engine-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
                  <button
                    type="button"
                    className={`engine-chip${form.tlsMode === "none" ? " engine-chip--active" : ""}`}
                    onClick={() => update("tlsMode", "none")}
                  >
                    <span>明文 HTTP</span>
                  </button>
                  <button
                    type="button"
                    className={`engine-chip${form.tlsMode === "tls" ? " engine-chip--active" : ""}`}
                    onClick={() => update("tlsMode", "tls")}
                  >
                    <span>TLS（推荐）</span>
                  </button>
                </div>
              </div>

              {form.tlsMode === "tls" && (
                <>
                  <div className="form-field">
                    <label className="form-label">CA 证书（PEM，可选）</label>
                    <textarea
                      className="input"
                      rows={3}
                      placeholder="-----BEGIN CERTIFICATE-----&#10;..."
                      value={form.caCert}
                      onChange={(e) => update("caCert", e.target.value)}
                      style={{ width: "100%", resize: "vertical", fontFamily: "monospace" }}
                    />
                  </div>
                  <div className="form-field">
                    <label className="form-label">客户端证书（PEM，可选）</label>
                    <textarea
                      className="input"
                      rows={3}
                      placeholder="-----BEGIN CERTIFICATE-----&#10;..."
                      value={form.clientCert}
                      onChange={(e) => update("clientCert", e.target.value)}
                      style={{ width: "100%", resize: "vertical", fontFamily: "monospace" }}
                    />
                  </div>
                  <div className="form-field">
                    <label className="form-label">客户端私钥（PEM，可选）</label>
                    <textarea
                      className="input"
                      rows={3}
                      placeholder="-----BEGIN PRIVATE KEY-----&#10;..."
                      value={form.clientKey}
                      onChange={(e) => update("clientKey", e.target.value)}
                      style={{ width: "100%", resize: "vertical", fontFamily: "monospace" }}
                    />
                    <p className="form-hint">远端 Engine 启用 mTLS 时填写，否则保持空。</p>
                  </div>
                </>
              )}
            </>
          )}

          {form.source === "onepanel" && (
            <>
              <div className="form-field">
                <label className="form-label">1Panel 面板地址</label>
                <input
                  className="input"
                  placeholder="http://192.168.1.2:9999"
                  value={form.panelBaseUrl}
                  onChange={(e) => update("panelBaseUrl", e.target.value)}
                  style={{ width: "100%" }}
                />
              </div>
              <div className="form-field">
                <label className="form-label">API Key</label>
                <input
                  className="input"
                  type="password"
                  placeholder="1Panel 面板设置中的 API Key"
                  value={form.panelApiKey}
                  onChange={(e) => update("panelApiKey", e.target.value)}
                  style={{ width: "100%" }}
                />
              </div>
              <div className="form-field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <input
                  id="panel-insecure"
                  type="checkbox"
                  checked={form.panelInsecure}
                  onChange={(e) => update("panelInsecure", e.target.checked)}
                />
                <label htmlFor="panel-insecure" className="form-label" style={{ marginBottom: 0 }}>
                  允许 HTTPS 自签证书
                </label>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
                1Panel 适配器当前不支持日志流式订阅、容器 exec、镜像 push/pull/build。
              </div>
            </>
          )}

          {form.source === "ssh-engine" && (
            <>
              <div className="form-row">
                <div className="form-field" style={{ flex: 2 }}>
                  <label className="form-label">SSH 主机</label>
                  <input
                    className="input"
                    placeholder="ssh.example.com"
                    value={form.sshHost}
                    onChange={(e) => update("sshHost", e.target.value)}
                    style={{ width: "100%" }}
                  />
                </div>
                <div className="form-field" style={{ flex: 1 }}>
                  <label className="form-label">端口</label>
                  <input
                    className="input"
                    placeholder="22"
                    value={form.sshPort}
                    onChange={(e) => update("sshPort", e.target.value)}
                    style={{ width: "100%" }}
                  />
                </div>
              </div>

              <div className="form-field">
                <label className="form-label">用户名</label>
                <input
                  className="input"
                  placeholder="root"
                  value={form.sshUser}
                  onChange={(e) => update("sshUser", e.target.value)}
                  style={{ width: "100%" }}
                />
              </div>

              <div className="form-field">
                <label className="form-label">认证方式</label>
                <div className="engine-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
                  <button
                    type="button"
                    className={`engine-chip${form.sshAuth === "password" ? " engine-chip--active" : ""}`}
                    onClick={() => update("sshAuth", "password")}
                  >
                    <span>密码</span>
                  </button>
                  <button
                    type="button"
                    className={`engine-chip${form.sshAuth === "privateKey" ? " engine-chip--active" : ""}`}
                    onClick={() => update("sshAuth", "privateKey")}
                  >
                    <span>私钥</span>
                  </button>
                </div>
              </div>

              {form.sshAuth === "password" ? (
                <div className="form-field">
                  <label className="form-label">密码</label>
                  <input
                    className="input"
                    type="password"
                    placeholder="••••••"
                    value={form.sshPassword}
                    onChange={(e) => update("sshPassword", e.target.value)}
                    style={{ width: "100%" }}
                  />
                </div>
              ) : (
                <>
                  <div className="form-field">
                    <label className="form-label">私钥（PEM）</label>
                    <textarea
                      className="input"
                      rows={4}
                      placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..."
                      value={form.sshPem}
                      onChange={(e) => update("sshPem", e.target.value)}
                      style={{ width: "100%", resize: "vertical", fontFamily: "monospace" }}
                    />
                  </div>
                  <div className="form-field">
                    <label className="form-label">私钥密码（可选）</label>
                    <input
                      className="input"
                      type="password"
                      placeholder="无"
                      value={form.sshPassphrase}
                      onChange={(e) => update("sshPassphrase", e.target.value)}
                      style={{ width: "100%" }}
                    />
                  </div>
                </>
              )}

              {sshConnections.length > 0 && (
                <div className="form-field">
                  <label className="form-label">绑定现有 SSH 连接（可选）</label>
                  <Select
                    className="input"
                    value={form.boundSshConnectionId}
                    onChange={(v) => update("boundSshConnectionId", v)}
                    style={{ width: "100%" }}
                    searchable={sshConnections.length >= 8}
                    options={[
                      { value: "", label: "不绑定（独立连接）" },
                      ...sshConnections.map((c) => ({ value: c.id, label: c.name })),
                    ]}
                  />
                  <p className="form-hint">绑定后可在工作区中复用此 SSH 会话并贯通上下文。</p>
                </div>
              )}

              {/* Quick-fill from connected SSH hosts */}
              {connectedHosts.length > 0 && (
                <div className="form-field">
                  <label className="form-label">快速选择已连接的 SSH 主机</label>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {connectedHosts.map((h) => (
                      <button
                        key={h.connectionId}
                        type="button"
                        className="engine-chip"
                        style={{ padding: "4px 10px", fontSize: 12 }}
                        onClick={() => handleUseSshHost(h)}
                      >
                        {h.name} ({h.user}@{h.host}:{h.port})
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Auto-detect Docker on bound SSH connection */}
              {form.boundSshConnectionId && (
                <div className="form-field">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ alignSelf: "flex-start" }}
                    disabled={detecting}
                    onClick={() => handleDetectDocker(form.boundSshConnectionId)}
                  >
                    {detecting ? "探测中…" : "🔍 自动探测 Docker"}
                  </button>
                  {detectResult && (
                    <div
                      style={{
                        marginTop: 6,
                        padding: "8px 12px",
                        borderRadius: 6,
                        fontSize: 12,
                        background: detectResult.available
                          ? "rgba(34,197,94,0.1)"
                          : "rgba(239,68,68,0.1)",
                        border: `1px solid ${detectResult.available ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`,
                        color: detectResult.available ? "#22c55e" : "#ef4444",
                      }}
                    >
                      {detectResult.available ? (
                        <>
                          ✅ Docker 已安装 — 版本 <strong>{detectResult.version}</strong>
                          {detectResult.os && <> · {detectResult.os}</>}
                          <br />
                          容器: {detectResult.containers} · 镜像: {detectResult.images}
                        </>
                      ) : (
                        <>❌ {detectResult.error || "Docker 未安装或不可用"}</>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          <div className="form-row">
            <div className="form-field" style={{ flex: 1 }}>
              <label className="form-label">环境标签</label>
              <Select
                className="input"
                value={form.envTag}
                onChange={(v) => update("envTag", v)}
                style={{ width: "100%" }}
                searchable={false}
                options={ENV_OPTIONS}
              />
            </div>
            <div className="form-field" style={{ flex: 1 }}>
              <label className="form-label">分组</label>
              <input
                className="input"
                placeholder="默认"
                value={form.group}
                onChange={(e) => update("group", e.target.value)}
                style={{ width: "100%" }}
              />
            </div>
          </div>
    </FormDialog>
  );
}
