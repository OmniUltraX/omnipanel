import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../../i18n";
import { SftpPanel } from "../../../components/sftp";
import { LogViewer } from "../../../components/ui/content/LogViewer";
import { Button } from "../../../components/ui/primitives/Button";
import { SubWindow } from "../../../components/ui/window/SubWindow";
import { TextEditorSubWindow } from "../../../components/textEditor/TextEditorSubWindow";
import type { TextEditorIO } from "../../../components/textEditor/types";
import { createOnePanelClient } from "../../../lib/onepanel";
import { makeOnePanelSftpAdapter } from "./onePanelSftpAdapter";
import type { ServerEntry } from "./serverConnection";
import { certificateRowLabel } from "./serverResourceLabels";

function formatValue(value: unknown): string {
  if (value == null || value === "") return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function KvPanel({
  rows,
  loading,
  error,
}: {
  rows: Array<{ label: string; value: string }>;
  loading?: boolean;
  error?: string | null;
}) {
  const { t } = useI18n();
  if (loading) {
    return <div className="server-apps-empty">{t("server.refreshing")}</div>;
  }
  if (error) {
    return <div className="server-apps-error">{error}</div>;
  }
  return (
    <div className="drawer-section server-website-detail">
      <dl className="drawer-kv">
        {rows.map((row) => (
          <div key={row.label} style={{ display: "contents" }}>
            <dt>{row.label}</dt>
            <dd>
              <pre className="server-website-detail__value">{row.value}</pre>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function WebsiteInfoSubWindow({
  open,
  server,
  websiteId,
  title,
  onClose,
}: {
  open: boolean;
  server: ServerEntry;
  websiteId: number | null;
  title: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (!open || websiteId == null || server.serviceType !== "1panel") {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const client = createOnePanelClient(server.address, server.key);
        const detail = await client.getWebsite(websiteId);
        if (!cancelled) setData(detail);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setData(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, server, websiteId]);

  const rows = useMemo(() => {
    if (!data) return [];
    const preferred = [
      ["primaryDomain", t("server.websites.fields.domain")],
      ["alias", t("server.websites.fields.alias")],
      ["type", t("server.websites.fields.type")],
      ["protocol", t("server.websites.fields.protocol")],
      ["status", t("server.websites.columns.status")],
      ["sitePath", t("server.websites.columns.path")],
      ["remark", t("server.create.remark")],
      ["createdAt", t("server.websites.fields.createdAt")],
    ] as const;
    const used = new Set<string>();
    const out: Array<{ label: string; value: string }> = [];
    for (const [key, label] of preferred) {
      if (!(key in data)) continue;
      used.add(key);
      out.push({ label, value: formatValue(data[key]) });
    }
    for (const [key, value] of Object.entries(data)) {
      if (used.has(key)) continue;
      if (value && typeof value === "object") continue;
      out.push({ label: key, value: formatValue(value) });
    }
    return out;
  }, [data, t]);

  return (
    <SubWindow
      open={open}
      title={title}
      onClose={onClose}
      widthRatio={0.56}
      heightRatio={0.72}
      className="server-website-subwindow"
    >
      <KvPanel rows={rows} loading={loading} error={error} />
    </SubWindow>
  );
}

export function WebsiteDirSubWindow({
  open,
  server,
  path,
  title,
  onClose,
}: {
  open: boolean;
  server: ServerEntry;
  path: string;
  title: string;
  onClose: () => void;
}) {
  const adapter = useMemo(
    () => (open && server.serviceType === "1panel" ? makeOnePanelSftpAdapter(server) : null),
    [open, server],
  );
  const cacheKey = `onepanel-website-dir:${server.id}:${path}`;

  return (
    <SubWindow
      open={open}
      title={title}
      onClose={onClose}
      widthRatio={0.86}
      heightRatio={0.82}
      className="server-website-subwindow server-website-subwindow--sftp"
    >
      {open && adapter ? (
        <SftpPanel
          resourceId={null}
          adapter={adapter}
          cacheKey={cacheKey}
          initialPath={path || "/"}
        />
      ) : null}
    </SubWindow>
  );
}

export function WebsiteLogsSubWindow({
  open,
  server,
  websiteId,
  title,
  onClose,
}: {
  open: boolean;
  server: ServerEntry;
  websiteId: number | null;
  title: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [logName, setLogName] = useState<"access.log" | "error.log">("access.log");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");

  const refresh = async (name = logName) => {
    if (websiteId == null || server.serviceType !== "1panel") return;
    setLoading(true);
    setError(null);
    try {
      const client = createOnePanelClient(server.address, server.key);
      const result = await client.readWebsiteLog({ id: websiteId, name });
      setText(result.content);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setText("");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) {
      setText("");
      setError(null);
      return;
    }
    void refresh(logName);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅随窗口打开 / 日志类型刷新
  }, [open, websiteId, server, logName]);

  return (
    <SubWindow
      open={open}
      title={title}
      onClose={onClose}
      widthRatio={0.82}
      heightRatio={0.78}
      className="server-website-subwindow server-website-subwindow--logs"
    >
      <LogViewer
        className="server-website-logs"
        text={text}
        loading={loading}
        error={error}
        emptyText={t("server.websites.logsEmpty")}
        onClear={() => setText("")}
        toolbar={
          <>
            <Button
              variant={logName === "access.log" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setLogName("access.log")}
            >
              {t("server.websites.accessLog")}
            </Button>
            <Button
              variant={logName === "error.log" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setLogName("error.log")}
            >
              {t("server.websites.errorLog")}
            </Button>
            <Button variant="ghost" size="sm" disabled={loading} onClick={() => void refresh()}>
              {loading ? t("server.refreshing") : t("server.refresh")}
            </Button>
          </>
        }
      />
    </SubWindow>
  );
}

export function WebsiteConfigSubWindow({
  open,
  server,
  websiteId,
  title,
  onClose,
}: {
  open: boolean;
  server: ServerEntry;
  websiteId: number | null;
  title: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [subtitle, setSubtitle] = useState("");

  const io = useMemo<TextEditorIO | null>(() => {
    if (!open || websiteId == null || server.serviceType !== "1panel") return null;
    const client = createOnePanelClient(server.address, server.key);
    return {
      async readText() {
        const file = await client.getWebsiteConfig(websiteId, "openresty");
        setSubtitle(typeof file.path === "string" ? file.path : "");
        return typeof file.content === "string" ? file.content : "";
      },
      async writeText(text: string) {
        await client.updateWebsiteNginx(websiteId, text);
      },
    };
  }, [open, server, websiteId]);

  return (
    <TextEditorSubWindow
      open={open}
      title={title}
      subtitle={subtitle || t("server.websites.config")}
      io={io}
      language="nginx"
      editable
      onClose={onClose}
      className="server-website-subwindow server-website-subwindow--config"
    />
  );
}

export function WebsiteCertSubWindow({
  open,
  server,
  websiteId,
  sslId,
  title,
  onClose,
}: {
  open: boolean;
  server: ServerEntry;
  websiteId: number | null;
  sslId: number | null;
  title: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (!open || server.serviceType !== "1panel") {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const client = createOnePanelClient(server.address, server.key);
        let detail: Record<string, unknown> = {};
        if (websiteId != null) {
          try {
            detail = await client.getWebsiteSsl(websiteId);
          } catch {
            detail = {};
          }
        }
        if ((!detail || Object.keys(detail).length === 0) && sslId != null) {
          detail = await client.getSslById(sslId);
        }
        if (!cancelled) {
          if (!detail || Object.keys(detail).length === 0) {
            setError(t("server.websites.certEmpty"));
            setData(null);
          } else {
            setData(detail);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setData(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, server, websiteId, sslId, t]);

  const rows = useMemo(() => {
    if (!data) return [];
    const preferred = [
      ["primaryDomain", t("server.websites.fields.domain")],
      ["domains", t("server.websites.fields.domains")],
      ["provider", t("server.websites.fields.provider")],
      ["autoRenew", t("server.websites.fields.autoRenew")],
      ["expireDate", t("server.websites.fields.expireDate")],
      ["startDate", t("server.websites.fields.startDate")],
      ["status", t("server.websites.columns.status")],
      ["description", t("server.websites.fields.description")],
    ] as const;
    const used = new Set<string>();
    const out: Array<{ label: string; value: string }> = [];
    for (const [key, label] of preferred) {
      if (!(key in data)) continue;
      used.add(key);
      out.push({ label, value: formatValue(data[key]) });
    }
    const domain = certificateRowLabel(data);
    if (domain && domain !== "—" && !used.has("primaryDomain") && !used.has("domains")) {
      out.unshift({ label: t("server.websites.fields.domain"), value: domain });
    }
    return out;
  }, [data, t]);

  return (
    <SubWindow
      open={open}
      title={title}
      onClose={onClose}
      widthRatio={0.56}
      heightRatio={0.72}
      className="server-website-subwindow"
    >
      <KvPanel rows={rows} loading={loading} error={error} />
    </SubWindow>
  );
}
