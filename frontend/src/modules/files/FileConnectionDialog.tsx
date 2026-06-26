import { useCallback, useEffect, useMemo, useState } from "react";
import { FormDialog } from "../../components/ui/FormDialog";
import { SecretInput } from "../../components/ui/SecretInput";
import { Select } from "../../components/ui/Select";
import { useI18n } from "../../i18n";
import { commands, type Connection } from "../../ipc/bindings";
import { useConnectionStore } from "../../stores/connectionStore";
import { saveFileConnection } from "./fileApi";

export type FileProtocol = "local" | "ftp" | "sftp" | "s3";

export type FileConfigJson = {
  protocol: FileProtocol;
  host?: string;
  port?: number;
  user?: string;
  rootPath?: string;
  tls?: boolean;
  sshConnectionId?: string;
  bucket?: string;
  region?: string;
  endpoint?: string;
  /** 公开访问自定义域名，如 cdn.example.com */
  publicDomain?: string;
  prefix?: string;
  accessKey?: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
  onTestSuccess?: (connectionId: string) => void;
  editConnection?: Connection;
  /** 新建连接时预选的协议（编辑时忽略） */
  initialProtocol?: FileProtocol;
};

const EMPTY = {
  name: "",
  protocol: "ftp" as FileProtocol,
  host: "",
  port: "21",
  user: "",
  secret: "",
  rootPath: "/",
  tls: false,
  sshConnectionId: "",
  bucket: "",
  region: "us-east-1",
  endpoint: "",
  publicDomain: "",
  prefix: "",
  accessKey: "",
};

function parseConfig(conn?: Connection): typeof EMPTY {
  if (!conn) return { ...EMPTY };
  try {
    const cfg = JSON.parse(conn.config || "{}") as FileConfigJson;
    return {
      name: conn.name,
      protocol: (cfg.protocol as FileProtocol) || "ftp",
      host: cfg.host ?? "",
      port: String(cfg.port ?? (cfg.protocol === "sftp" ? 22 : cfg.protocol === "s3" ? "" : 21)),
      user: cfg.user ?? "",
      secret: "",
      rootPath: cfg.rootPath ?? "/",
      tls: cfg.tls ?? false,
      sshConnectionId: cfg.sshConnectionId ?? "",
      bucket: cfg.bucket ?? "",
      region: cfg.region ?? "us-east-1",
      endpoint: cfg.endpoint ?? "",
      publicDomain: cfg.publicDomain ?? "",
      prefix: cfg.prefix ?? "",
      accessKey: cfg.accessKey ?? "",
    };
  } catch {
    return { ...EMPTY, name: conn.name };
  }
}

function buildConnection(form: typeof EMPTY, existing?: Connection): Connection {
  const cfg: FileConfigJson = {
    protocol: form.protocol,
    rootPath: form.rootPath.trim() || "/",
  };
  if (form.protocol === "ftp" || form.protocol === "sftp") {
    cfg.host = form.host.trim();
    cfg.port = parseInt(form.port, 10) || (form.protocol === "sftp" ? 22 : 21);
    cfg.user = form.user.trim();
    cfg.tls = form.tls;
  }
  if (form.protocol === "sftp" && form.sshConnectionId) {
    cfg.sshConnectionId = form.sshConnectionId;
  }
  if (form.protocol === "s3") {
    cfg.bucket = form.bucket.trim();
    cfg.region = form.region.trim();
    cfg.endpoint = form.endpoint.trim();
    cfg.publicDomain = form.publicDomain.trim();
    cfg.prefix = form.prefix.trim();
    cfg.accessKey = form.accessKey.trim();
  }
  const now = Math.floor(Date.now() / 1000);
  return {
    id: existing?.id ?? "",
    kind: "file",
    name: form.name.trim(),
    group: form.protocol === "s3" ? "S3 存储" : "远程连接",
    envTag: existing?.envTag ?? "unknown",
    tags: existing?.tags ?? [],
    config: JSON.stringify(cfg),
    credentialRef: existing?.credentialRef,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function defaultPortForProtocol(protocol: FileProtocol): string {
  if (protocol === "sftp") return "22";
  if (protocol === "s3") return "";
  return "21";
}

export function FileConnectionDialog({
  open,
  onClose,
  onSaved,
  onTestSuccess,
  editConnection,
  initialProtocol,
}: Props) {
  const { t } = useI18n();
  const connections = useConnectionStore((s) => s.connections);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const sshOptions = useMemo(
    () =>
      connections
        .filter((c) => c.kind === "ssh")
        .map((c) => ({ value: c.id, label: c.name })),
    [connections],
  );

  useEffect(() => {
    if (!open) return;
    if (editConnection) {
      setForm(parseConfig(editConnection));
    } else {
      const protocol = initialProtocol ?? "ftp";
      setForm({ ...EMPTY, protocol, port: defaultPortForProtocol(protocol) });
    }
    setError(null);
    setSuccessMsg(null);
    setSaving(false);
    setTesting(false);
  }, [open, editConnection, initialProtocol]);

  const update = <K extends keyof typeof EMPTY>(key: K, value: (typeof EMPTY)[K]) => {
    setError(null);
    setSuccessMsg(null);
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const validate = (): string | null => {
    if (!form.name.trim()) return t("files.dialog.nameRequired");
    if (form.protocol === "ftp" || form.protocol === "sftp") {
      if (!form.sshConnectionId && !form.host.trim()) return t("files.dialog.hostRequired");
      if (!form.sshConnectionId && !form.user.trim()) return t("files.dialog.userRequired");
    }
    if (form.protocol === "s3") {
      if (!form.bucket.trim()) return t("files.dialog.bucketRequired");
      if (!form.accessKey.trim()) return t("files.dialog.accessKeyRequired");
      if (!form.secret.trim() && !editConnection?.credentialRef) return t("files.dialog.secretRequired");
    }
    if ((form.protocol === "ftp" || form.protocol === "sftp") && !form.sshConnectionId) {
      if (!form.secret.trim() && !editConnection?.credentialRef) return t("files.dialog.secretRequired");
    }
    return null;
  };

  const handleTest = useCallback(async () => {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setTesting(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const conn = buildConnection(form, editConnection);
      const res = await commands.connTest(conn);
      if (res.status === "ok" && res.data !== undefined) {
        setSuccessMsg(res.data);
        if (editConnection?.id) {
          onTestSuccess?.(editConnection.id);
        }
      } else if (res.status === "error") {
        const e = res.error;
        setError(e.cause ? `${e.message}（${e.cause}）` : e.message);
      } else {
        setError("测试失败");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setTesting(false);
    }
  }, [form, editConnection, onTestSuccess]);

  const handleSave = async () => {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setSaving(true);
    try {
      const conn = buildConnection(form, editConnection);
      await saveFileConnection(conn, form.secret.trim() || null);
      onSaved?.();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const showRemote = form.protocol === "ftp" || form.protocol === "sftp";
  const showS3 = form.protocol === "s3";

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={editConnection ? t("files.dialog.editTitle") : t("files.dialog.addTitle")}
      size="md"
      onCancel={onClose}
      cancelDisabled={saving}
      status={successMsg ? { kind: "success", message: successMsg } : error ? { kind: "error", message: error } : null}
      actions={[
        {
          label: testing ? t("files.dialog.testing") : t("files.dialog.testConnection"),
          disabled: testing || saving,
          variant: "secondary",
          onClick: () => void handleTest(),
        },
      ]}
      primaryAction={{
        label: saving ? t("common.saving") : t("files.dialog.connect"),
        disabled: saving,
        onClick: () => void handleSave(),
      }}
    >
      <div className="form-field">
        <label className="form-label">{t("files.dialog.type")}</label>
        <Select
          value={form.protocol}
          onChange={(v) => update("protocol", v as FileProtocol)}
          options={[
            { value: "local", label: t("files.protocol.local") },
            { value: "ftp", label: "FTP" },
            { value: "sftp", label: "SFTP" },
            { value: "s3", label: "S3" },
          ]}
          style={{ width: "100%" }}
        />
      </div>

      <div className="form-field">
        <label className="form-label">{t("files.dialog.name")}</label>
        <input
          className="input"
          value={form.name}
          onChange={(e) => update("name", e.target.value)}
          placeholder={t("files.dialog.namePlaceholder")}
          style={{ width: "100%" }}
        />
      </div>

      {showRemote && (
        <>
          {form.protocol === "sftp" && sshOptions.length > 0 && (
            <div className="form-field">
              <label className="form-label">{t("files.dialog.sshLink")}</label>
              <Select
                value={form.sshConnectionId}
                onChange={(v) => update("sshConnectionId", v)}
                options={[{ value: "", label: t("files.dialog.sshLinkNone") }, ...sshOptions]}
                style={{ width: "100%" }}
              />
            </div>
          )}
          {!form.sshConnectionId && (
            <>
              <div className="form-row">
                <div className="form-field" style={{ flex: 2 }}>
                  <label className="form-label">{t("files.dialog.host")}</label>
                  <input className="input" value={form.host} onChange={(e) => update("host", e.target.value)} style={{ width: "100%" }} />
                </div>
                <div className="form-field" style={{ flex: 1 }}>
                  <label className="form-label">{t("files.dialog.port")}</label>
                  <input className="input" value={form.port} onChange={(e) => update("port", e.target.value)} style={{ width: "100%" }} />
                </div>
              </div>
              <div className="form-row">
                <div className="form-field" style={{ flex: 1 }}>
                  <label className="form-label">{t("files.dialog.user")}</label>
                  <input className="input" value={form.user} onChange={(e) => update("user", e.target.value)} style={{ width: "100%" }} />
                </div>
                <div className="form-field" style={{ flex: 1 }}>
                  <label className="form-label">{t("files.dialog.password")}</label>
                  <SecretInput value={form.secret} onChange={(v) => update("secret", v)} placeholder="••••••••" />
                </div>
              </div>
            </>
          )}
          <div className="form-field">
            <label className="form-label">{t("files.dialog.rootPath")}</label>
            <input className="input" value={form.rootPath} onChange={(e) => update("rootPath", e.target.value)} style={{ width: "100%" }} />
          </div>
        </>
      )}

      {showS3 && (
        <>
          <div className="form-field">
            <label className="form-label">{t("files.dialog.bucket")}</label>
            <input className="input" value={form.bucket} onChange={(e) => update("bucket", e.target.value)} style={{ width: "100%" }} />
          </div>
          <div className="form-row">
            <div className="form-field" style={{ flex: 1 }}>
              <label className="form-label">{t("files.dialog.region")}</label>
              <input className="input" value={form.region} onChange={(e) => update("region", e.target.value)} style={{ width: "100%" }} />
            </div>
            <div className="form-field" style={{ flex: 1 }}>
              <label className="form-label">{t("files.dialog.endpoint")}</label>
              <input className="input" value={form.endpoint} onChange={(e) => update("endpoint", e.target.value)} style={{ width: "100%" }} />
            </div>
          </div>
          <div className="form-field">
            <label className="form-label">{t("files.dialog.publicDomain")}</label>
            <input
              className="input"
              value={form.publicDomain}
              onChange={(e) => update("publicDomain", e.target.value)}
              placeholder={t("files.dialog.publicDomainPlaceholder")}
              style={{ width: "100%" }}
            />
            <p className="form-field-hint">{t("files.dialog.publicDomainDesc")}</p>
          </div>
          <div className="form-row">
            <div className="form-field" style={{ flex: 1 }}>
              <label className="form-label">{t("files.dialog.accessKey")}</label>
              <input className="input" value={form.accessKey} onChange={(e) => update("accessKey", e.target.value)} style={{ width: "100%" }} />
            </div>
            <div className="form-field" style={{ flex: 1 }}>
              <label className="form-label">{t("files.dialog.secretKey")}</label>
              <SecretInput value={form.secret} onChange={(v) => update("secret", v)} placeholder="••••••••" />
            </div>
          </div>
          <div className="form-field">
            <label className="form-label">{t("files.dialog.prefix")}</label>
            <input className="input" value={form.prefix} onChange={(e) => update("prefix", e.target.value)} style={{ width: "100%" }} />
          </div>
        </>
      )}
    </FormDialog>
  );
}
