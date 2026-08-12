import { useEffect, useMemo, useState } from "react";
import { FormDialog } from "../../components/ui/form/FormDialog";
import { PasswordInput } from "../../components/ui/form/PasswordInput";
import { Select } from "../../components/ui/form/Select";
import { TextInput } from "../../components/ui/form/TextInput";
import { useConnectionStore } from "../../stores/connectionStore";
import { sanitizeSshGroupInput } from "../../lib/sshGroups";
import type { Connection } from "../../ipc/bindings";
import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { useI18n } from "../../i18n";
import { GlobalTagEditor } from "../tags/GlobalTagEditor";
import { mergeConnectionTags, userConnectionTags } from "../tags/tagKinds";
import { BrandIconImg } from "../server/brandIcons";
import dockerBrandIcon from "../../assets/icons/docker.svg";

interface DockerConnectionDialogProps {
  open: boolean;
  onClose: () => void;
  onSaved?: (connection: Connection) => void;
  editConnection?: Connection;
  /** 打开编辑表单时的提示（如缺少绑定 SSH），展示在表单顶部 info 区 */
  statusHint?: string | null;
}

type Source = "ssh-engine" | "onepanel" | "btpanel";
type SshAuth = "password" | "privateKey";

interface DockerForm {
  name: string;
  group: string;
  envTag: string;
  source: Source;
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

const EMPTY: DockerForm = {
  name: "",
  group: "默认",
  envTag: "unknown",
  source: "ssh-engine",
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
  panelInsecure: true,
};

function sshConfigFromConnection(conn: Connection): Record<string, unknown> | null {
  try {
    const cfg = JSON.parse(conn.config || "{}") as Record<string, unknown>;
    if (typeof cfg.host !== "string" || typeof cfg.user !== "string") return null;
    return {
      host: cfg.host,
      port: typeof cfg.port === "number" ? cfg.port : 22,
      user: cfg.user,
      auth: cfg.auth ?? { type: "password", password: "" },
    };
  } catch {
    return null;
  }
}

function applyBoundSshToForm(form: DockerForm, conn: Connection): DockerForm {
  const ssh = sshConfigFromConnection(conn);
  if (!ssh) return form;
  const auth = ssh.auth as Record<string, unknown> | undefined;
  const next: DockerForm = {
    ...form,
    boundSshConnectionId: conn.id,
    sshHost: String(ssh.host),
    sshPort: String(ssh.port),
    sshUser: String(ssh.user),
    group: conn.group || form.group,
    envTag: conn.envTag || form.envTag,
  };
  if (!form.name.trim()) {
    next.name = `Docker - ${conn.name}`;
  }
  if (auth?.type === "privateKey") {
    next.sshAuth = "privateKey";
    next.sshPem = "";
    next.sshPassphrase = "";
  } else {
    next.sshAuth = "password";
    next.sshPassword = "";
  }
  return next;
}

function formToConfig(form: DockerForm, sshConnections: Connection[]): string {
  if (form.source === "onepanel") {
    return formToOnePanelConfig(form);
  }
  if (form.source === "btpanel") {
    return formToBtPanelConfig(form);
  }
  // ssh-engine
  if (form.boundSshConnectionId.trim()) {
    const bound = sshConnections.find((c) => c.id === form.boundSshConnectionId.trim());
    const ssh = bound ? sshConfigFromConnection(bound) : null;
    if (ssh) {
      const cfg: Record<string, unknown> = {
        source: "ssh-engine",
        host: `${ssh.user}@${ssh.host}:${ssh.port}`,
        boundSshConnectionId: form.boundSshConnectionId.trim(),
        ssh,
      };
      return JSON.stringify(cfg);
    }
  }
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
    boundSshConnectionId: form.boundSshConnectionId.trim(),
    onepanel: {
      baseUrl: form.panelBaseUrl.trim(),
      apiKey: form.panelApiKey,
      insecure: form.panelInsecure,
    },
  };
  return JSON.stringify(cfg);
}

function formToBtPanelConfig(form: DockerForm): string {
  const cfg: Record<string, unknown> = {
    source: "btpanel",
    host: form.panelBaseUrl.trim(),
    boundSshConnectionId: form.boundSshConnectionId.trim(),
    btpanel: {
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
  const source = typeof cfg.source === "string" ? cfg.source : "ssh-engine";
  if (source === "ssh-engine" || source === "remote-engine" || source === "local-engine") {
    base.source = "ssh-engine";
    if (source === "remote-engine" && typeof cfg.host === "string") {
      base.sshHost = cfg.host;
      if (typeof cfg.port === "number") base.sshPort = String(cfg.port);
    }
    const ssh = cfg.ssh as Record<string, unknown> | undefined;
    if (ssh) {
      if (typeof ssh.host === "string") base.sshHost = ssh.host;
      if (typeof ssh.port === "number") base.sshPort = String(ssh.port);
      if (typeof ssh.user === "string") base.sshUser = ssh.user;
      const auth = ssh.auth as Record<string, unknown> | undefined;
      if (auth) {
        if (auth.type === "privateKey") {
          base.sshAuth = "privateKey";
          base.sshPem = "";
          base.sshPassphrase = "";
        } else {
          base.sshAuth = "password";
          base.sshPassword = "";
        }
      }
    }
    if (typeof cfg.boundSshConnectionId === "string") {
      base.boundSshConnectionId = cfg.boundSshConnectionId;
    }
  } else if (source === "onepanel" || source === "one-panel") {
    base.source = "onepanel";
    const panel = cfg.onepanel as Record<string, unknown> | undefined;
    if (panel) {
      if (typeof panel.baseUrl === "string") base.panelBaseUrl = panel.baseUrl;
      base.panelApiKey = "";
      if (panel.insecure === true) base.panelInsecure = true;
    }
    if (typeof cfg.boundSshConnectionId === "string") {
      base.boundSshConnectionId = cfg.boundSshConnectionId;
    }
  } else if (source === "btpanel" || source === "baota" || source === "panel-adapter") {
    base.source = "btpanel";
    const panel =
      (cfg.btpanel as Record<string, unknown> | undefined) ??
      (cfg.panel as Record<string, unknown> | undefined);
    if (panel) {
      if (typeof panel.baseUrl === "string") base.panelBaseUrl = panel.baseUrl;
      base.panelApiKey = "";
      if (panel.insecure === true) base.panelInsecure = true;
    } else if (typeof cfg.host === "string") {
      base.panelBaseUrl = cfg.host;
    }
    if (typeof cfg.boundSshConnectionId === "string") {
      base.boundSshConnectionId = cfg.boundSshConnectionId;
    }
  }
  return base;
}

export function DockerConnectionDialog({
  open,
  onClose,
  onSaved,
  editConnection,
  statusHint = null,
}: DockerConnectionDialogProps) {
  const { t } = useI18n();
  const saveConn = useConnectionStore((s) => s.save);
  const connections = useConnectionStore((s) => s.connections);

  const [form, setForm] = useState<DockerForm>(EMPTY);
  const [tags, setTags] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sshManualMode, setSshManualMode] = useState(false);
  const [legacySourceNotice, setLegacySourceNotice] = useState<string | null>(null);

  const sshConnections = useMemo(
    () => connections.filter((c) => c.kind === "ssh"),
    [connections]
  );

  const isEdit = !!editConnection?.id;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    if (editConnection) {
      let cfgSource = "ssh-engine";
      try {
        const cfg = editConnection.config
          ? (JSON.parse(editConnection.config) as Record<string, unknown>)
          : {};
        if (typeof cfg.source === "string") cfgSource = cfg.source;
      } catch {
        /* ignore */
      }
      const next = connectionToForm(editConnection);
      setForm(next);
      setSshManualMode(!next.boundSshConnectionId);
      setLegacySourceNotice(
        cfgSource === "remote-engine"
          ? "原「远程 Engine API 直连」已不再支持，请改用 SSH 宿主机、1Panel 或宝塔并重新保存。"
          : null,
      );
      setTags(userConnectionTags(editConnection.tags));

      // config 不存明文 API Key；编辑时从 Vault 回显
      if (next.source === "onepanel" || next.source === "btpanel") {
        void unwrapCommand(commands.dockerGetConnectionSecret(editConnection.id), {
          quiet: true,
        })
          .then((secret) => {
            if (cancelled || !secret.trim()) return;
            setForm((prev) =>
              prev.panelApiKey.trim() ? prev : { ...prev, panelApiKey: secret },
            );
          })
          .catch(() => {
            /* Vault 无密钥或读取失败：保持空，由用户填写 */
          });
      }
    } else {
      setForm(EMPTY);
      setSshManualMode(false);
      setLegacySourceNotice(null);
      setTags([]);
    }
    setError(null);
    setSaving(false);
    return () => {
      cancelled = true;
    };
  }, [open, editConnection]);

  if (!open) return null;

  const update = <K extends keyof DockerForm>(key: K, value: DockerForm[K]) => {
    setError(null);
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const validate = (): string | null => {
    if (!form.name.trim()) return "请输入连接名称";
    if (form.source === "ssh-engine") {
      if (!sshManualMode) {
        if (!form.boundSshConnectionId.trim()) return "请选择已配置的 SSH 连接";
      } else {
        if (!form.sshHost.trim()) return "请输入 SSH 主机";
        if (!form.sshUser.trim()) return "请输入 SSH 用户名";
        if (form.sshAuth === "password" && !form.sshPassword.trim()) return "请输入 SSH 密码";
        if (form.sshAuth === "privateKey" && !form.sshPem.trim()) return "请输入 SSH 私钥";
      }
    }
    if (form.source === "onepanel") {
      if (!form.panelBaseUrl.trim()) return "请输入 1Panel 面板地址";
      // 编辑时留空表示保留 Vault 原密钥（异步回显前也可保存）
      if (!isEdit && !form.panelApiKey.trim()) return "请输入 1Panel API Key";
      if (!form.boundSshConnectionId.trim()) return "请绑定 SSH 连接（无面板接口时回退）";
    }
    if (form.source === "btpanel") {
      if (!form.panelBaseUrl.trim()) return "请输入宝塔面板地址";
      if (!isEdit && !form.panelApiKey.trim()) return "请输入宝塔 API Key";
      if (!form.boundSshConnectionId.trim()) return "请绑定 SSH 连接（无面板接口时回退）";
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
        tags: mergeConnectionTags(tags, editConnection?.tags),
        config: formToConfig(form, sshConnections),
      };
      const saved = await saveConn(conn);
      if (!saved) {
        setError("保存失败");
        return;
      }
      onSaved?.(saved);
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
      status={
        error
          ? { kind: "error", message: error }
          : statusHint
            ? { kind: "info", message: statusHint }
            : legacySourceNotice
              ? { kind: "info", message: legacySourceNotice }
              : null
      }
      primaryAction={{
        label: saving ? "保存中…" : "保存",
        disabled: saving,
        onClick: () => void handleSave(),
      }}
    >
          <div className="form-field">
            <label className="form-label">连接名称</label>
            <TextInput
              placeholder="例如：本地 Docker / 生产 K8s 节点 / 192.168.1.10"
              value={form.name}
              onChange={(value) => update("name", value)}
              style={{ width: "100%" }}
            />
          </div>

          <div className="form-field">
            <label className="form-label">引擎来源</label>
            <div className="engine-grid" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
              {(
                [
                  { value: "ssh-engine" as const, label: "SSH 宿主机", hint: "在远端调用 docker CLI" },
                  { value: "onepanel" as const, label: "1Panel 面板", hint: "通过 /api/v2 调用" },
                  { value: "btpanel" as const, label: "宝塔面板", hint: "面板地址 + API Key" },
                ]
              ).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`engine-chip${form.source === opt.value ? " engine-chip--active" : ""}`}
                  onClick={() => {
                    setError(null);
                    setForm((prev) => ({
                      ...prev,
                      source: opt.value,
                      ...(opt.value === "btpanel" ? { panelInsecure: true } : {}),
                    }));
                  }}
                >
                  {opt.value === "ssh-engine" ? (
                    <span className="engine-chip-icon">
                      <img
                        src={dockerBrandIcon}
                        alt=""
                        width={18}
                        height={18}
                        className="engine-chip-logo"
                        draggable={false}
                      />
                    </span>
                  ) : null}
                  {opt.value === "onepanel" ? (
                    <span className="engine-chip-icon">
                      <BrandIconImg kind="1panel" size={18} className="engine-chip-logo" />
                    </span>
                  ) : null}
                  {opt.value === "btpanel" ? (
                    <span className="engine-chip-icon">
                      <BrandIconImg kind="bt" size={18} className="engine-chip-logo" />
                    </span>
                  ) : null}
                  <div className="engine-chip-title">{opt.label}</div>
                  <div className="engine-chip-hint">{opt.hint}</div>
                </button>
              ))}
            </div>
            <p className="form-hint" style={{ marginTop: 8 }}>
              本机 Docker 已默认可用，无需添加连接；此处配置远程 SSH、1Panel 或宝塔面板。
            </p>
          </div>

          {(form.source === "onepanel" || form.source === "btpanel") && (
            <>
              <div className="form-field">
                <label className="form-label">
                  {form.source === "btpanel" ? "宝塔面板地址" : "1Panel 面板地址"}
                </label>
                <TextInput
                  placeholder={
                    form.source === "btpanel"
                      ? "http://192.168.1.2:8888"
                      : "http://192.168.1.2:9999"
                  }
                  value={form.panelBaseUrl}
                  onChange={(value) => update("panelBaseUrl", value)}
                  style={{ width: "100%" }}
                />
              </div>
              <div className="form-field">
                <label className="form-label">API Key</label>
                <PasswordInput
                  copyable
                  placeholder={
                    isEdit
                      ? "已保存则回显；留空表示保留原密钥"
                      : form.source === "btpanel"
                        ? "宝塔面板设置 → API 接口密钥"
                        : "1Panel 面板设置中的 API Key"
                  }
                  value={form.panelApiKey}
                  onChange={(value) => update("panelApiKey", value)}
                  style={{ width: "100%" }}
                />
              </div>
              <div className="form-field">
                <label className="form-label">绑定 SSH 连接</label>
                {sshConnections.length > 0 ? (
                  <>
                    <Select
                      className="input"
                      value={form.boundSshConnectionId}
                      onChange={(v) => update("boundSshConnectionId", v)}
                      style={{ width: "100%" }}
                      searchable={sshConnections.length >= 8}
                      options={[
                        { value: "", label: "请选择…" },
                        ...sshConnections.map((c) => ({ value: c.id, label: c.name })),
                      ]}
                    />
                    <p className="form-hint" style={{ marginTop: 6 }}>
                      必填。面板有 HTTP 接口时走 API；无对应接口（如宝塔 Compose 配置/日志、stats）时回退到该
                      SSH 上的 Docker。
                    </p>
                  </>
                ) : (
                  <p className="form-hint">请先在 SSH 模块添加主机连接，再绑定到此面板 Docker。</p>
                )}
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
                  {form.source === "btpanel" ? "（宝塔建议开启）" : ""}
                </label>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
                {form.source === "btpanel"
                  ? "容器/镜像/网络/卷等优先走宝塔 HTTP API；其余能力走绑定 SSH。"
                  : "1Panel HTTP API 优先；无对应接口时走绑定 SSH。"}
              </div>
            </>
          )}

          {form.source === "ssh-engine" && (
            <>
              {sshConnections.length > 0 ? (
                <div className="form-field">
                  <label className="form-label">选择 SSH 连接</label>
                  <Select
                    className="input"
                    value={form.boundSshConnectionId}
                    onChange={(v) => {
                      const conn = sshConnections.find((c) => c.id === v);
                      if (conn) {
                        setForm((prev) => applyBoundSshToForm(prev, conn));
                        setSshManualMode(false);
                      } else {
                        update("boundSshConnectionId", v);
                      }
                    }}
                    style={{ width: "100%" }}
                    searchable={sshConnections.length >= 8}
                    options={[
                      { value: "", label: "请选择…" },
                      ...sshConnections.map((c) => ({ value: c.id, label: c.name })),
                    ]}
                  />
                  <p className="form-hint">优先复用 SSH 模块已保存的连接，无需重复填写账号密码。</p>
                </div>
              ) : (
                <div className="form-hint" style={{ marginBottom: 8 }}>
                  暂无已配置的 SSH 连接，请先在 SSH 模块添加，或使用下方手动填写。
                </div>
              )}

              <div className="form-field">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setSshManualMode((v) => !v)}
                >
                  {sshManualMode ? "收起手动填写" : "高级：手动填写 SSH"}
                </button>
              </div>

              {sshManualMode && (
                <>
              <div className="form-row">
                <div className="form-field" style={{ flex: 2 }}>
                  <label className="form-label">SSH 主机</label>
                  <TextInput
                    placeholder="ssh.example.com"
                    value={form.sshHost}
                    onChange={(value) => update("sshHost", value)}
                    style={{ width: "100%" }}
                  />
                </div>
                <div className="form-field" style={{ flex: 1 }}>
                  <label className="form-label">端口</label>
                  <TextInput
                    placeholder="22"
                    value={form.sshPort}
                    onChange={(value) => update("sshPort", value)}
                    style={{ width: "100%" }}
                  />
                </div>
              </div>

              <div className="form-field">
                <label className="form-label">用户名</label>
                <TextInput
                  placeholder="root"
                  value={form.sshUser}
                  onChange={(value) => update("sshUser", value)}
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
                  <PasswordInput
                    copyable
                    placeholder="••••••"
                    value={form.sshPassword}
                    onChange={(value) => update("sshPassword", value)}
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
                    <PasswordInput
                      placeholder="无"
                      value={form.sshPassphrase}
                      onChange={(value) => update("sshPassphrase", value)}
                      style={{ width: "100%" }}
                    />
                  </div>
                </>
              )}

                </>
              )}

              {!sshManualMode && form.boundSshConnectionId && (
                <div className="form-hint">
                  将绑定 SSH 连接 <strong>{sshConnections.find((c) => c.id === form.boundSshConnectionId)?.name ?? form.boundSshConnectionId}</strong>，保存后复用其凭据与会话。
                </div>
              )}
            </>
          )}

          <div className="form-section-title">{t("resourceTags.section")}</div>
          <GlobalTagEditor
            kind="connection"
            resourceId={editConnection?.id ?? ""}
            tags={tags}
            onChange={setTags}
          />
    </FormDialog>
  );
}
