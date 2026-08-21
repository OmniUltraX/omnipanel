import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../../i18n";
import { SftpPanel } from "../../../components/sftp";
import { LogViewer } from "../../../components/ui/content/LogViewer";
import { Button } from "../../../components/ui/primitives/Button";
import { SubWindow } from "../../../components/ui/window/SubWindow";
import { TextEditorSubWindow } from "../../../components/textEditor/TextEditorSubWindow";
import type { TextEditorIO } from "../../../components/textEditor/types";
import { createBtPanelClient } from "../../../lib/btpanel";
import { createOnePanelClient } from "../../../lib/onepanel";
import { appConfirm } from "../../../lib/appConfirm";
import { showToast } from "../../../stores/toastStore";
import { makeBtPanelSftpAdapter } from "./btPanelSftpAdapter";
import { makeOnePanelSftpAdapter } from "./onePanelSftpAdapter";
import type { ServerEntry } from "./serverConnection";
import { certificateRowLabel } from "./serverResourceLabels";
import { isBtPanelService, isOnePanelService } from "./panelPlugin";

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
  emptyText,
}: {
  rows: Array<{ label: string; value: string }>;
  loading?: boolean;
  error?: string | null;
  emptyText?: string;
}) {
  const { t } = useI18n();
  if (loading) {
    return <div className="server-apps-empty">{t("common.loading")}</div>;
  }
  if (error) {
    return <div className="server-apps-error">{error}</div>;
  }
  if (rows.length === 0) {
    return (
      <div className="server-apps-empty">
        {emptyText || t("server.websites.detailEmpty")}
      </div>
    );
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
  siteName = null,
  title,
  onClose,
}: {
  open: boolean;
  server: ServerEntry;
  websiteId: number | null;
  siteName?: string | null;
  title: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (!open || websiteId == null) {
      setData(null);
      setError(null);
      return;
    }
    if (!isOnePanelService(server.serviceType) && !isBtPanelService(server.serviceType)) {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        if (isBtPanelService(server.serviceType)) {
          if (!siteName) throw new Error(t("server.websites.missingSiteName"));
          const client = createBtPanelClient(server.address, server.key, server.id);
          // 串行：任一鉴权失败由 client 熔断，避免 4 路并发打满验证计数
          const sites = await client.getWebsiteList({ limit: 200 });
          const domains = await client.getSiteDomains(websiteId).catch(() => null);
          const phpInfo = await client.getSitePhpVersion(siteName).catch(() => ({}));
          const ssl = await client.getSiteSsl(siteName).catch(() => ({}));
          const site = sites.data.find((row) => row.id === websiteId) ?? null;
          const detail: Record<string, unknown> = {
            primaryDomain: siteName,
            ...(site ?? {}),
            domains,
            php: phpInfo,
            ssl,
          };
          if (!cancelled) setData(detail);
          return;
        }
        const client = createOnePanelClient(server.address, server.key, server.id);
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
  }, [open, server, websiteId, siteName, t]);

  const rows = useMemo(() => {
    if (!data) return [];
    const preferred = [
      ["primaryDomain", t("server.websites.fields.domain")],
      ["name", t("server.websites.fields.domain")],
      ["alias", t("server.websites.fields.alias")],
      ["type", t("server.websites.fields.type")],
      ["protocol", t("server.websites.fields.protocol")],
      ["status", t("server.websites.columns.status")],
      ["sitePath", t("server.websites.columns.path")],
      ["path", t("server.websites.columns.path")],
      ["ps", t("server.create.remark")],
      ["remark", t("server.create.remark")],
      ["addtime", t("server.websites.fields.createdAt")],
      ["createdAt", t("server.websites.fields.createdAt")],
      ["php", t("server.create.website.phpVersion")],
      ["domains", t("server.websites.fields.domains")],
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
  const adapter = useMemo(() => {
    if (!open) return null;
    if (isOnePanelService(server.serviceType)) return makeOnePanelSftpAdapter(server);
    if (isBtPanelService(server.serviceType)) return makeBtPanelSftpAdapter(server);
    return null;
  }, [open, server]);
  const cacheKey = `panel-website-dir:${server.serviceType}:${server.id}:${path}`;

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
  siteName = null,
  title,
  onClose,
}: {
  open: boolean;
  server: ServerEntry;
  websiteId: number | null;
  siteName?: string | null;
  title: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [logName, setLogName] = useState<"access.log" | "error.log">("access.log");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");

  const refresh = async (name = logName) => {
    if (isBtPanelService(server.serviceType)) {
      if (!siteName) return;
      setLoading(true);
      setError(null);
      try {
        const client = createBtPanelClient(server.address, server.key, server.id);
        const content =
          name === "error.log"
            ? await client.getSiteErrorLogs(siteName)
            : await client.getSiteAccessLogs(siteName);
        setText(content);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setText("");
      } finally {
        setLoading(false);
      }
      return;
    }
    if (websiteId == null || !isOnePanelService(server.serviceType)) return;
    setLoading(true);
    setError(null);
    try {
      const client = createOnePanelClient(server.address, server.key, server.id);
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
  }, [open, websiteId, siteName, server, logName]);

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

export function CertificateLogsSubWindow({
  open,
  server,
  sslId,
  title,
  onClose,
}: {
  open: boolean;
  server: ServerEntry;
  sslId: number | null;
  title: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");

  const refresh = async () => {
    if (sslId == null || !isOnePanelService(server.serviceType)) return;
    setLoading(true);
    setError(null);
    try {
      const client = createOnePanelClient(server.address, server.key, server.id);
      const result = await client.readSslLog({ id: sslId, latest: true });
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
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅随窗口打开刷新
  }, [open, sslId, server]);

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
        emptyText={t("server.certificates.logsEmpty")}
        onClear={() => setText("")}
        toolbar={
          <Button variant="ghost" size="sm" disabled={loading} onClick={() => void refresh()}>
            {loading ? t("server.refreshing") : t("server.refresh")}
          </Button>
        }
      />
    </SubWindow>
  );
}

export function WebsiteConfigSubWindow({
  open,
  server,
  websiteId,
  siteName = null,
  title,
  onClose,
}: {
  open: boolean;
  server: ServerEntry;
  websiteId: number | null;
  siteName?: string | null;
  title: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [subtitle, setSubtitle] = useState("");

  const io = useMemo<TextEditorIO | null>(() => {
    if (!open) return null;
    if (isBtPanelService(server.serviceType)) {
      if (!siteName) return null;
      const client = createBtPanelClient(server.address, server.key, server.id);
      return {
        async readText() {
          const file = await client.getNginxConfig(siteName);
          setSubtitle(file.path);
          return file.content;
        },
        async writeText(text: string) {
          await client.saveNginxConfig(siteName, text);
        },
      };
    }
    if (websiteId == null || !isOnePanelService(server.serviceType)) return null;
    const client = createOnePanelClient(server.address, server.key, server.id);
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
  }, [open, server, websiteId, siteName]);

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
  siteName = null,
  sslId,
  title,
  onClose,
}: {
  open: boolean;
  server: ServerEntry;
  websiteId: number | null;
  siteName?: string | null;
  sslId: number | null;
  title: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [closingSsl, setClosingSsl] = useState(false);

  const reload = async () => {
    if (isBtPanelService(server.serviceType)) {
      if (!siteName) throw new Error(t("server.websites.missingSiteName"));
      const client = createBtPanelClient(server.address, server.key, server.id);
      const detail = (await client.getSiteSsl(siteName)) as Record<string, unknown>;
      if (!detail || Object.keys(detail).length === 0) {
        setError(t("server.websites.certEmpty"));
        setData(null);
      } else {
        setError(null);
        setData(detail);
      }
      return;
    }
    const client = createOnePanelClient(server.address, server.key, server.id);
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
    if (!detail || Object.keys(detail).length === 0) {
      setError(t("server.websites.certEmpty"));
      setData(null);
    } else {
      setError(null);
      setData(detail);
    }
  };

  useEffect(() => {
    if (!open) {
      setData(null);
      setError(null);
      return;
    }
    if (!isOnePanelService(server.serviceType) && !isBtPanelService(server.serviceType)) {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        await reload();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅随窗口打开参数刷新
  }, [open, server, websiteId, siteName, sslId, t]);

  const handleCloseSsl = async () => {
    if (!isBtPanelService(server.serviceType) || !siteName || closingSsl) return;
    const confirmed = await appConfirm(
      t("server.certificates.btSslCloseConfirm", { name: siteName }),
      t("server.certificates.btSslClose"),
    );
    if (!confirmed) return;
    setClosingSsl(true);
    setError(null);
    try {
      const client = createBtPanelClient(server.address, server.key, server.id);
      await client.closeSiteSsl(siteName);
      showToast(t("server.certificates.btSslCloseSuccess"));
      setData(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setClosingSsl(false);
    }
  };

  const rows = useMemo(() => {
    if (!data) return [];
    const preferred = [
      ["primaryDomain", t("server.websites.fields.domain")],
      ["domain", t("server.websites.fields.domains")],
      ["domains", t("server.websites.fields.domains")],
      ["provider", t("server.websites.fields.provider")],
      ["autoRenew", t("server.websites.fields.autoRenew")],
      ["expireDate", t("server.websites.fields.expireDate")],
      ["startDate", t("server.websites.fields.startDate")],
      ["cert_data", t("server.websites.fields.description")],
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
    for (const [key, value] of Object.entries(data)) {
      if (used.has(key)) continue;
      if (key === "key" || key === "csr" || key === "private_key" || key === "cert") continue;
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
      <KvPanel rows={rows} loading={loading} error={error} emptyText={t("server.websites.certEmpty")} />
      {data && typeof data.primaryDomain === "string" ? (
        <div className="form-hint" style={{ padding: "0 12px 12px" }}>
          {certificateRowLabel(data)}
        </div>
      ) : null}
      {isBtPanelService(server.serviceType) && siteName && data ? (
        <div style={{ padding: "0 12px 12px", display: "flex", gap: 8 }}>
          <Button
            type="button"
            variant="danger"
            size="sm"
            disabled={closingSsl || loading}
            onClick={() => void handleCloseSsl()}
          >
            {closingSsl ? t("common.saving") : t("server.certificates.btSslClose")}
          </Button>
        </div>
      ) : null}
    </SubWindow>
  );
}
