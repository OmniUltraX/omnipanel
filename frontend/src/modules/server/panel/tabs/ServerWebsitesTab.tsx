import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { useI18n } from "../../../../i18n";
import { Button } from "../../../../components/ui/primitives/Button";
import {
  IconFile,
  IconFolder,
  IconLink,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconSettings,
  IconStop,
} from "../../../../components/ui/Icons";
import {
  DbTablesPanelGrid,
  type DbTablesPanelGridColumn,
  type DbTablesPanelGridSortDirection,
} from "../../../database/workspace/DbTablesPanelGrid";
import { createOnePanelClient } from "../../../../lib/onepanel";
import { useServerPanelCacheStore } from "../../../../stores/serverPanelCacheStore";
import type { ServerEntry } from "../serverConnection";
import { useServerWebsites } from "../useServerWebsites";
import { useServerCertificates } from "../useServerCertificates";
import {
  isWebsiteRunning,
  isWebsiteStopped,
  websiteCertificateDaysBadgeClass,
  websiteCertificateDaysBadgeStyle,
  websiteCertificateInfo,
  websiteNumericId,
  websiteRowId,
  websiteRowLabel,
  websiteRowPath,
  websiteRowStatus,
  websiteRowType,
  websiteRowUrl,
  websiteSslId,
  websiteStatusBadgeClass,
} from "../serverResourceLabels";
import {
  WebsiteCertSubWindow,
  WebsiteConfigSubWindow,
  WebsiteDirSubWindow,
  WebsiteInfoSubWindow,
  WebsiteLogsSubWindow,
} from "../WebsiteActionSubWindows";
import { CreateWebsiteDialog } from "../ServerResourceCreateDialogs";

interface Props {
  server: ServerEntry;
  selectedItemId?: string | null;
}

type WebsiteAction =
  | { kind: "info"; websiteId: number; title: string }
  | { kind: "dir"; path: string; title: string }
  | { kind: "logs"; websiteId: number; title: string }
  | { kind: "config"; websiteId: number; title: string }
  | { kind: "cert"; websiteId: number | null; sslId: number | null; title: string };

type WebsiteSortColumn = "domain" | "type" | "path" | "status" | "certificate";

type WebsiteGridRow = {
  id: string;
  domain: string;
  url: string | null;
  type: string;
  path: string;
  status: string;
  certDaysLeft: number | null;
  certExpireRaw: string | null;
  hasCert: boolean;
  websiteId: number | null;
  sslId: number | null;
};

const WEBSITE_TYPE_KEYS = new Set([
  "static",
  "runtime",
  "deployment",
  "proxy",
  "stream",
  "subsite",
]);

function compareText(a: string, b: string, direction: DbTablesPanelGridSortDirection): number {
  const cmp = a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
  return direction === "asc" ? cmp : -cmp;
}

function compareNullableNumber(
  a: number | null,
  b: number | null,
  direction: DbTablesPanelGridSortDirection,
): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  const cmp = a - b;
  return direction === "asc" ? cmp : -cmp;
}

function formatWebsiteError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function ServerWebsitesTab({ server, selectedItemId }: Props) {
  const { t } = useI18n();
  const { items: rows, loading, error, refresh } = useServerWebsites(server);
  const {
    items: certificates,
    loading: certificatesLoading,
    error: certificatesError,
  } = useServerCertificates(server);
  const gridWrapRef = useRef<HTMLDivElement | null>(null);
  const [action, setAction] = useState<WebsiteAction | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [sortColumn, setSortColumn] = useState<WebsiteSortColumn>("domain");
  const [sortDirection, setSortDirection] = useState<DbTablesPanelGridSortDirection>("asc");
  const [statusBusyId, setStatusBusyId] = useState<number | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const isOnePanel = server.serviceType === "1panel";

  const formatWebsiteType = useCallback(
    (type: string) => {
      if (!type || type === "—") return "—";
      const key = type.trim().toLowerCase();
      if (WEBSITE_TYPE_KEYS.has(key)) {
        return t(`server.websites.types.${key}` as "server.websites.types.static");
      }
      return type;
    },
    [t],
  );

  const gridRows = useMemo<WebsiteGridRow[]>(
    () =>
      rows.map((row, index) => {
        const cert = websiteCertificateInfo(row, certificates);
        let url = websiteRowUrl(row);
        if (cert.hasCert && url?.startsWith("http://")) {
          url = `https://${url.slice("http://".length)}`;
        }
        return {
          id: websiteRowId(row, index),
          domain: websiteRowLabel(row),
          url,
          type: websiteRowType(row),
          path: websiteRowPath(row),
          status: websiteRowStatus(row),
          certDaysLeft: cert.daysLeft,
          certExpireRaw: cert.expireRaw,
          hasCert: cert.hasCert,
          websiteId: websiteNumericId(row),
          sslId: websiteSslId(row),
        };
      }),
    [certificates, rows],
  );

  const sortedRows = useMemo(() => {
    const next = [...gridRows];
    next.sort((a, b) => {
      if (sortColumn === "certificate") {
        return compareNullableNumber(a.certDaysLeft, b.certDaysLeft, sortDirection);
      }
      if (sortColumn === "type") {
        return compareText(formatWebsiteType(a.type), formatWebsiteType(b.type), sortDirection);
      }
      return compareText(a[sortColumn], b[sortColumn], sortDirection);
    });
    return next;
  }, [formatWebsiteType, gridRows, sortColumn, sortDirection]);

  useEffect(() => {
    if (!selectedItemId) return;
    const selected = gridWrapRef.current?.querySelector("tr.is-selected");
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedItemId, sortedRows.length]);

  const serverRefreshing = useServerPanelCacheStore((s) =>
    Boolean(s.refreshingServerIds[server.id]),
  );
  const refreshing = loading || certificatesLoading || serverRefreshing;

  const handleRefresh = () => {
    void refresh();
    // certificates 与 websites 同属一次 refreshServer，无需再单独拉
  };

  const handleToggleStatus = useCallback(
    async (row: WebsiteGridRow) => {
      if (!isOnePanel || row.websiteId == null || statusBusyId != null) return;
      const running = isWebsiteRunning(row.status);
      const stopped = isWebsiteStopped(row.status);
      if (!running && !stopped) return;
      const operate = running ? "stop" : "start";
      setStatusBusyId(row.websiteId);
      setStatusError(null);
      try {
        const client = createOnePanelClient(server.address, server.key);
        await client.operateWebsite(row.websiteId, operate);
        await refresh();
      } catch (err) {
        setStatusError(formatWebsiteError(err));
      } finally {
        setStatusBusyId(null);
      }
    },
    [isOnePanel, refresh, server.address, server.key, statusBusyId],
  );

  const toggleSort = (columnId: string) => {
    const next = columnId as WebsiteSortColumn;
    if (sortColumn === next) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }
    setSortColumn(next);
    setSortDirection("asc");
  };

  const columns = useMemo((): DbTablesPanelGridColumn<WebsiteGridRow>[] => {
    return [
      {
        id: "domain",
        sortId: "domain",
        header: t("server.websites.columns.domain"),
        sortable: true,
        nameCell: true,
        defaultWidth: 200,
        minWidth: 140,
        render: (row) => {
          const canOpenInfo = isOnePanel && row.websiteId != null;
          const domainNode = canOpenInfo ? (
            <button
              type="button"
              className="server-resource-text-btn"
              onClick={(event) => {
                event.stopPropagation();
                setAction({
                  kind: "info",
                  websiteId: row.websiteId!,
                  title: t("server.websites.infoTitle", { name: row.domain }),
                });
              }}
            >
              {row.domain}
            </button>
          ) : (
            <span className="server-resource-path-text">{row.domain}</span>
          );
          return (
            <div className="server-resource-path-cell" onClick={(event) => event.stopPropagation()}>
              {domainNode}
              {row.url ? (
                <Button
                  type="button"
                  variant="icon"
                  size="icon-xs"
                  className="db-connection-info-deploy-action-btn"
                  title={t("server.websites.openInBrowser")}
                  aria-label={t("server.websites.openInBrowser")}
                  onClick={() => {
                    void openExternal(row.url!).catch(() => {
                      window.open(row.url!, "_blank", "noopener,noreferrer");
                    });
                  }}
                >
                  <IconLink size={14} />
                </Button>
              ) : null}
            </div>
          );
        },
        getTitle: (row) => row.domain,
        getCopyValue: (row) => row.domain,
      },
      {
        id: "type",
        sortId: "type",
        header: t("server.websites.columns.type"),
        sortable: true,
        defaultWidth: 100,
        minWidth: 72,
        render: (row) => (
          <span className="badge badge-muted">{formatWebsiteType(row.type)}</span>
        ),
        getTitle: (row) => formatWebsiteType(row.type),
        getCopyValue: (row) => formatWebsiteType(row.type),
      },
      {
        id: "path",
        sortId: "path",
        header: t("server.websites.columns.path"),
        sortable: true,
        defaultWidth: 240,
        minWidth: 140,
        copyable: true,
        render: (row) => {
          const canOpenDir = isOnePanel && Boolean(row.path);
          return (
            <div className="server-resource-path-cell" onClick={(event) => event.stopPropagation()}>
              <span className="text-muted server-resource-path-text">{row.path || "—"}</span>
              {canOpenDir ? (
                <Button
                  type="button"
                  variant="icon"
                  size="icon-xs"
                  className="db-connection-info-deploy-action-btn"
                  title={t("server.websites.openDir")}
                  aria-label={t("server.websites.openDir")}
                  onClick={() =>
                    setAction({
                      kind: "dir",
                      path: row.path,
                      title: t("server.websites.dirTitle", { name: row.domain }),
                    })
                  }
                >
                  <IconFolder size={14} />
                </Button>
              ) : null}
            </div>
          );
        },
        getTitle: (row) => row.path || undefined,
        getCopyValue: (row) => row.path || undefined,
      },
      {
        id: "status",
        sortId: "status",
        header: t("server.websites.columns.status"),
        sortable: true,
        defaultWidth: 128,
        minWidth: 100,
        render: (row) => {
          const running = isWebsiteRunning(row.status);
          const stopped = isWebsiteStopped(row.status);
          const canToggle = isOnePanel && row.websiteId != null && (running || stopped);
          const busy = statusBusyId === row.websiteId;
          const actionLabel = running
            ? t("server.websites.stopWebsite")
            : t("server.websites.startWebsite");
          return (
            <div
              className="server-resource-status-cell"
              onClick={(event) => event.stopPropagation()}
            >
              <span className={websiteStatusBadgeClass(row.status)}>{row.status}</span>
              {canToggle ? (
                <Button
                  type="button"
                  variant={running ? "danger" : "icon"}
                  size="icon-xs"
                  className={running ? undefined : "db-connection-info-deploy-action-btn"}
                  disabled={busy || statusBusyId != null}
                  title={busy ? t("server.websites.statusBusy") : actionLabel}
                  aria-label={busy ? t("server.websites.statusBusy") : actionLabel}
                  onClick={() => void handleToggleStatus(row)}
                >
                  {running ? <IconStop size={14} /> : <IconPlay size={14} />}
                </Button>
              ) : null}
            </div>
          );
        },
        getTitle: (row) => row.status,
        getCopyValue: (row) => row.status,
      },
      {
        id: "certificate",
        sortId: "certificate",
        header: t("server.websites.columns.certificate"),
        sortable: true,
        defaultWidth: 120,
        minWidth: 88,
        render: (row) => {
          const label =
            row.certDaysLeft == null
              ? row.hasCert
                ? t("server.websites.certNoExpire")
                : "—"
              : row.certDaysLeft < 0
                ? t("server.websites.certExpired")
                : row.certDaysLeft === 0
                  ? t("server.websites.certExpiresToday")
                  : t("server.websites.certDaysLeft", { days: row.certDaysLeft });
          const badge = (
            <span
              className={websiteCertificateDaysBadgeClass(row.certDaysLeft)}
              style={websiteCertificateDaysBadgeStyle(row.certDaysLeft)}
            >
              {label}
            </span>
          );
          const canOpenCert =
            isOnePanel && row.hasCert && (row.websiteId != null || row.sslId != null);
          if (!canOpenCert) return badge;
          return (
            <button
              type="button"
              className="server-resource-text-btn"
              title={row.certExpireRaw ?? label}
              onClick={(event) => {
                event.stopPropagation();
                setAction({
                  kind: "cert",
                  websiteId: row.websiteId,
                  sslId: row.sslId,
                  title: t("server.websites.certTitle", { name: row.domain }),
                });
              }}
            >
              {badge}
            </button>
          );
        },
        getTitle: (row) => row.certExpireRaw ?? undefined,
        getCopyValue: (row) => row.certExpireRaw ?? undefined,
      },
      {
        id: "actions",
        header: t("server.websites.columns.actions"),
        variant: "actionsSticky",
        copyable: false,
        resizable: false,
        defaultWidth: 72,
        minWidth: 72,
        render: (row) => {
          const canOpenLogs = isOnePanel && row.websiteId != null;
          const canOpenConfig = isOnePanel && row.websiteId != null;
          return (
            <div
              className="db-tables-panel-grid__row-actions"
              onClick={(event) => event.stopPropagation()}
            >
              <Button
                type="button"
                variant="icon"
                size="icon-xs"
                className="db-connection-info-deploy-action-btn"
                disabled={!canOpenLogs}
                title={canOpenLogs ? t("server.websites.logs") : t("server.websites.onePanelOnly")}
                aria-label={canOpenLogs ? t("server.websites.logs") : t("server.websites.onePanelOnly")}
                onClick={() => {
                  if (!canOpenLogs || row.websiteId == null) return;
                  setAction({
                    kind: "logs",
                    websiteId: row.websiteId,
                    title: t("server.websites.logsTitle", { name: row.domain }),
                  });
                }}
              >
                <IconFile size={14} />
              </Button>
              <Button
                type="button"
                variant="icon"
                size="icon-xs"
                className="db-connection-info-deploy-action-btn"
                disabled={!canOpenConfig}
                title={
                  canOpenConfig ? t("server.websites.config") : t("server.websites.onePanelOnly")
                }
                aria-label={
                  canOpenConfig ? t("server.websites.config") : t("server.websites.onePanelOnly")
                }
                onClick={() => {
                  if (!canOpenConfig || row.websiteId == null) return;
                  setAction({
                    kind: "config",
                    websiteId: row.websiteId,
                    title: t("server.websites.configTitle", { name: row.domain }),
                  });
                }}
              >
                <IconSettings size={14} />
              </Button>
            </div>
          );
        },
      },
    ];
  }, [formatWebsiteType, handleToggleStatus, isOnePanel, statusBusyId, t]);

  const renderTable = () => {
    if (loading && gridRows.length === 0) {
      return <div className="db-tables-panel-empty">{t("common.loading")}</div>;
    }
    if (error && gridRows.length === 0) {
      return <div className="db-tables-panel-error">{error}</div>;
    }
    if (gridRows.length === 0) {
      return <div className="db-tables-panel-empty">{t("server.websites.empty")}</div>;
    }
    return (
      <DbTablesPanelGrid
        variant="processlist"
        className="server-websites-grid"
        columns={columns}
        rows={sortedRows}
        rowKey={(row) => row.id}
        sortColumnId={sortColumn}
        sortDirection={sortDirection}
        onSortColumn={toggleSort}
        selectedRowKey={selectedItemId ?? null}
        columnResizeStorageKey={`omnipanel.server.websites.column-widths.${server.id}.v1`}
      />
    );
  };

  return (
    <div className="server-panel-tab server-websites-panel">
      <div className="server-panel-tab-toolbar">
        <span className="server-panel-tab-title">
          {t("server.tabs.websites")}
          <span className="badge badge-muted server-panel-tab-count">{gridRows.length}</span>
        </span>
        <Button
          type="button"
          variant="icon"
          size="icon-xs"
          disabled={!isOnePanel || refreshing}
          title={isOnePanel ? t("server.websites.create") : t("server.create.onePanelOnly")}
          aria-label={isOnePanel ? t("server.websites.create") : t("server.create.onePanelOnly")}
          onClick={() => setCreateOpen(true)}
        >
          <IconPlus size={14} />
        </Button>
        <Button
          type="button"
          variant="icon"
          size="icon-xs"
          disabled={refreshing}
          title={refreshing ? t("server.refreshing") : t("server.refresh")}
          aria-label={refreshing ? t("server.refreshing") : t("server.refresh")}
          onClick={handleRefresh}
        >
          <IconRefresh size={14} />
        </Button>
      </div>
      {(error && gridRows.length > 0) || (certificatesError && gridRows.length > 0) || statusError ? (
        <div className="db-tables-panel-error">{statusError ?? error ?? certificatesError}</div>
      ) : null}
      <div ref={gridWrapRef} className="db-tables-panel-grid-wrap server-websites-grid-wrap">
        {renderTable()}
      </div>

      <WebsiteInfoSubWindow
        open={action?.kind === "info"}
        server={server}
        websiteId={action?.kind === "info" ? action.websiteId : null}
        title={action?.kind === "info" ? action.title : ""}
        onClose={() => setAction(null)}
      />
      <WebsiteDirSubWindow
        open={action?.kind === "dir"}
        server={server}
        path={action?.kind === "dir" ? action.path : "/"}
        title={action?.kind === "dir" ? action.title : ""}
        onClose={() => setAction(null)}
      />
      <WebsiteLogsSubWindow
        open={action?.kind === "logs"}
        server={server}
        websiteId={action?.kind === "logs" ? action.websiteId : null}
        title={action?.kind === "logs" ? action.title : ""}
        onClose={() => setAction(null)}
      />
      <WebsiteConfigSubWindow
        open={action?.kind === "config"}
        server={server}
        websiteId={action?.kind === "config" ? action.websiteId : null}
        title={action?.kind === "config" ? action.title : ""}
        onClose={() => setAction(null)}
      />
      <WebsiteCertSubWindow
        open={action?.kind === "cert"}
        server={server}
        websiteId={action?.kind === "cert" ? action.websiteId : null}
        sslId={action?.kind === "cert" ? action.sslId : null}
        title={action?.kind === "cert" ? action.title : ""}
        onClose={() => setAction(null)}
      />
      <CreateWebsiteDialog
        open={createOpen}
        server={server}
        onClose={() => setCreateOpen(false)}
        onCreated={() => void refresh()}
      />
    </div>
  );
}
