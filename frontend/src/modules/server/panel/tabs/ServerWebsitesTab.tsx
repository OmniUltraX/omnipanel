import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { useI18n } from "../../../../i18n";
import { Button } from "../../../../components/ui/primitives/Button";
import { Select } from "../../../../components/ui/form/Select";
import { TextInput } from "../../../../components/ui/form/TextInput";
import {
  IconFile,
  IconFolder,
  IconLink,
  IconPencil,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconStop,
  IconTrash,
} from "../../../../components/ui/Icons";
import {
  DbTablesPanelGrid,
  type DbTablesPanelGridColumn,
  type DbTablesPanelGridSortDirection,
} from "../../../database/workspace/DbTablesPanelGrid";
import { createBtPanelClient, fetchBtMergedWebsiteList } from "../../../../lib/btpanel";
import { createOnePanelClient } from "../../../../lib/onepanel";
import type { ServerEntry } from "../serverConnection";
import { isBtPanelService, panelHasCapability } from "../panelPlugin";
import { useServerWebsites } from "../useServerWebsites";
import { useServerCertificates } from "../useServerCertificates";
import {
  isWebsiteRunning,
  isWebsiteStopped,
  websiteCertificateDaysBadgeClass,
  websiteCertificateDaysBadgeStyle,
  websiteCertificateInfo,
  websiteNumericId,
  websiteRowGroup,
  websiteRowGroupId,
  websiteRowId,
  websiteRowLabel,
  websiteRowPath,
  websiteRowStatus,
  websiteRowType,
  websiteRowUrl,
  websiteSiteName,
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
import { CreateWebsiteDialog, EditWebsiteDialog } from "../ServerResourceCreateDialogs";
import { appConfirm } from "../../../../lib/appConfirm";
import { showToast } from "../../../../stores/toastStore";
import { enrichWebsitesWithGroups } from "../serverPanelCacheRefresh";

interface Props {
  server: ServerEntry;
  selectedItemId?: string | null;
}

type WebsiteAction =
  | { kind: "info"; websiteId: number; siteName: string; title: string }
  | { kind: "dir"; path: string; title: string }
  | { kind: "logs"; websiteId: number; siteName: string; title: string }
  | { kind: "config"; websiteId: number; siteName: string; title: string }
  | {
      kind: "cert";
      websiteId: number | null;
      siteName: string | null;
      sslId: number | null;
      title: string;
    };

type WebsiteSortColumn = "domain" | "type" | "group" | "path" | "status" | "certificate";

type WebsiteGridRow = {
  id: string;
  domain: string;
  siteName: string | null;
  url: string | null;
  type: string;
  group: string;
  groupId: string | null;
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
  const { items: rows, siteGroups, loading, refreshing, error, refresh } = useServerWebsites(server);
  // 证书随 refreshServer 一并更新，此处只读缓存做到期天数关联
  const { items: certificates, error: certificatesError } = useServerCertificates(server, {
    autoRefresh: false,
  });
  const gridWrapRef = useRef<HTMLDivElement | null>(null);
  const [action, setAction] = useState<WebsiteAction | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<{ id: number; siteName: string } | null>(null);
  const [sortColumn, setSortColumn] = useState<WebsiteSortColumn>("domain");
  const [sortDirection, setSortDirection] = useState<DbTablesPanelGridSortDirection>("asc");
  const [statusBusyId, setStatusBusyId] = useState<number | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [actionBusyId, setActionBusyId] = useState<number | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [typeFilters, setTypeFilters] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<"" | "running" | "stopped">("");
  const [sslFilter, setSslFilter] = useState<"" | "yes" | "no" | "expired">("");
  const [remoteRows, setRemoteRows] = useState<Record<string, unknown>[] | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);

  const isBt = isBtPanelService(server.serviceType);
  const canManage = panelHasCapability(server.serviceType, "websites");

  useEffect(() => {
    setGroupFilter("");
    setTypeFilters([]);
    setStatusFilter("");
    setSslFilter("");
    setSearchInput("");
    setSearchQuery("");
    setRemoteRows(null);
    setRemoteError(null);
  }, [server.id]);

  // 搜索防抖：输入即滤
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearchQuery(searchInput.trim());
    }, 280);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  // 宝塔：筛选项变化时远端局部重拉（type / search），失败则回退本地筛选
  useEffect(() => {
    if (!isBt) {
      setRemoteRows(null);
      setRemoteError(null);
      setRemoteLoading(false);
      return;
    }
    const hasFilter = Boolean(searchQuery) || Boolean(groupFilter);
    if (!hasFilter) {
      setRemoteRows(null);
      setRemoteError(null);
      setRemoteLoading(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        setRemoteLoading(true);
        setRemoteError(null);
        try {
          const client = createBtPanelClient(server.address, server.key, server.id);
          const typeId =
            groupFilter && /^-?\d+$/.test(groupFilter) ? Number(groupFilter) : -1;
          const websites = await fetchBtMergedWebsiteList(client, {
            limit: 200,
            type: typeId,
            search: searchQuery || undefined,
          });
          if (cancelled) return;
          const enriched = enrichWebsitesWithGroups(websites, siteGroups ?? []);
          setRemoteRows(enriched);
        } catch (err) {
          if (cancelled) return;
          setRemoteRows(null);
          setRemoteError(formatWebsiteError(err));
        } finally {
          if (!cancelled) setRemoteLoading(false);
        }
      })();
    }, 320);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [groupFilter, isBt, searchQuery, server.address, server.id, server.key, siteGroups]);

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
      (remoteRows ?? rows ?? []).map((row, index) => {
        const cert = websiteCertificateInfo(row, certificates);
        let url = websiteRowUrl(row);
        if (cert.hasCert && url?.startsWith("http://")) {
          url = `https://${url.slice("http://".length)}`;
        }
        const domain = websiteRowLabel(row);
        return {
          id: websiteRowId(row, index),
          domain,
          siteName: websiteSiteName(row) ?? domain,
          url,
          type: websiteRowType(row),
          group: websiteRowGroup(row),
          groupId: websiteRowGroupId(row),
          path: websiteRowPath(row),
          status: websiteRowStatus(row),
          certDaysLeft: cert.daysLeft,
          certExpireRaw: cert.expireRaw,
          hasCert: cert.hasCert,
          websiteId: websiteNumericId(row),
          sslId: websiteSslId(row),
        };
      }),
    [certificates, remoteRows, rows],
  );

  // 类型选项来自完整缓存，避免筛选后选项消失
  const typeOptions = useMemo(() => {
    const set = new Set<string>();
    for (const row of rows ?? []) {
      const type = websiteRowType(row);
      if (type && type !== "—") set.add(type);
    }
    return [...set].sort((a, b) =>
      formatWebsiteType(a).localeCompare(formatWebsiteType(b), undefined, {
        sensitivity: "base",
        numeric: true,
      }),
    );
  }, [formatWebsiteType, rows]);

  const filteredRows = useMemo(() => {
    const remoteActive = isBt && remoteRows != null;
    const q = searchQuery.trim().toLowerCase();
    return gridRows.filter((row) => {
      // 分组 / 搜索：宝塔远端已筛时不再本地复筛
      if (!remoteActive) {
        if (groupFilter) {
          const matchId = row.groupId != null && row.groupId === groupFilter;
          const matchName = row.group === groupFilter;
          if (!matchId && !matchName) return false;
        }
        if (q) {
          const haystack = [row.domain, row.siteName, row.path, row.group, row.type, row.status]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          if (!haystack.includes(q)) return false;
        }
      }
      if (typeFilters.length > 0 && !typeFilters.includes(row.type)) return false;
      if (statusFilter === "running" && !isWebsiteRunning(row.status)) return false;
      if (statusFilter === "stopped" && !isWebsiteStopped(row.status)) return false;
      if (sslFilter === "yes" && !row.hasCert) return false;
      if (sslFilter === "no" && row.hasCert) return false;
      if (
        sslFilter === "expired" &&
        !(row.hasCert && row.certDaysLeft != null && row.certDaysLeft < 0)
      ) {
        return false;
      }
      return true;
    });
  }, [
    gridRows,
    groupFilter,
    isBt,
    remoteRows,
    searchQuery,
    sslFilter,
    statusFilter,
    typeFilters,
  ]);

  const sortedRows = useMemo(() => {
    const next = [...filteredRows];
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
  }, [filteredRows, formatWebsiteType, sortColumn, sortDirection]);

  useEffect(() => {
    if (!selectedItemId) return;
    const selected = gridWrapRef.current?.querySelector("tr.is-selected");
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedItemId, sortedRows.length]);

  const handleRefresh = () => {
    void refresh();
    // certificates 与 websites 同属一次 refreshServer，无需再单独拉
  };

  const handleToggleStatus = useCallback(
    async (row: WebsiteGridRow) => {
      if (!canManage || row.websiteId == null || statusBusyId != null) return;
      const running = isWebsiteRunning(row.status);
      const stopped = isWebsiteStopped(row.status);
      if (!running && !stopped) return;
      const operate = running ? "stop" : "start";
      setStatusBusyId(row.websiteId);
      setStatusError(null);
      try {
        if (isBt) {
          if (!row.siteName) throw new Error(t("server.websites.missingSiteName"));
          const client = createBtPanelClient(server.address, server.key, server.id);
          if (operate === "stop") {
            await client.stopWebsite(row.websiteId, row.siteName);
          } else {
            await client.startWebsite(row.websiteId, row.siteName);
          }
        } else {
          const client = createOnePanelClient(server.address, server.key, server.id);
          await client.operateWebsite(row.websiteId, operate);
        }
        await refresh();
        showToast(
          operate === "stop"
            ? t("server.websites.stopSuccess")
            : t("server.websites.startSuccess"),
        );
      } catch (err) {
        setStatusError(formatWebsiteError(err));
      } finally {
        setStatusBusyId(null);
      }
    },
    [canManage, isBt, refresh, server.address, server.id, server.key, statusBusyId, t],
  );

  const handleEditWebsite = useCallback((row: WebsiteGridRow) => {
    if (row.websiteId == null || !row.siteName) return;
    setEditTarget({ id: row.websiteId, siteName: row.siteName });
  }, []);

  const handleDeleteWebsite = useCallback(
    async (row: WebsiteGridRow) => {
      if (!canManage || row.websiteId == null || actionBusyId != null) return;
      const confirmed = await appConfirm(
        isBt
          ? t("server.websites.deleteConfirmWithPath", { name: row.domain })
          : t("server.websites.deleteConfirm", { name: row.domain }),
      );
      if (!confirmed) return;
      setActionBusyId(row.websiteId);
      setStatusError(null);
      try {
        if (isBt) {
          if (!row.siteName) throw new Error(t("server.websites.missingSiteName"));
          const client = createBtPanelClient(server.address, server.key, server.id);
          await client.deleteWebsite(row.websiteId, row.siteName, { path: true });
        } else {
          const client = createOnePanelClient(server.address, server.key, server.id);
          await client.deleteWebsite(row.websiteId);
        }
        showToast(t("server.websites.deleteSuccess"));
        await refresh();
      } catch (err) {
        setStatusError(formatWebsiteError(err));
      } finally {
        setActionBusyId(null);
      }
    },
    [actionBusyId, canManage, isBt, refresh, server.address, server.id, server.key, t],
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
        minWidth: 120,
        render: (row) => {
          const canOpenInfo = canManage && row.websiteId != null && Boolean(row.siteName);
          return (
            <div className="server-resource-path-cell" onClick={(event) => event.stopPropagation()}>
              {canOpenInfo ? (
                <button
                  type="button"
                  className="server-resource-text-btn server-resource-path-text"
                  title={t("server.websites.info")}
                  onClick={() => {
                    setAction({
                      kind: "info",
                      websiteId: row.websiteId!,
                      siteName: row.siteName!,
                      title: t("server.websites.infoTitle", { name: row.domain }),
                    });
                  }}
                >
                  {row.domain}
                </button>
              ) : (
                <span className="server-resource-path-text">{row.domain}</span>
              )}
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
        getCopyValue: (row) => {
          const label = formatWebsiteType(row.type);
          return label === "—" ? undefined : label;
        },
      },
      {
        id: "group",
        sortId: "group",
        header: t("server.websites.columns.group"),
        sortable: true,
        defaultWidth: 110,
        minWidth: 72,
        render: (row) => <span className="text-muted">{row.group || "—"}</span>,
        getTitle: (row) => row.group || undefined,
        getCopyValue: (row) => row.group || undefined,
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
          const canOpenDir = canManage && Boolean(row.path);
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
        defaultWidth: 100,
        minWidth: 72,
        render: (row) => {
          const running = isWebsiteRunning(row.status);
          const stopped = isWebsiteStopped(row.status);
          const label = running
            ? t("server.websites.statusRunning")
            : stopped
              ? t("server.websites.statusStopped")
              : row.status;
          return <span className={websiteStatusBadgeClass(row.status)}>{label}</span>;
        },
        getTitle: (row) => {
          if (isWebsiteRunning(row.status)) return t("server.websites.statusRunning");
          if (isWebsiteStopped(row.status)) return t("server.websites.statusStopped");
          return row.status;
        },
        getCopyValue: (row) => {
          if (isWebsiteRunning(row.status)) return t("server.websites.statusRunning");
          if (isWebsiteStopped(row.status)) return t("server.websites.statusStopped");
          return row.status;
        },
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
              title={row.certExpireRaw ?? undefined}
            >
              {label}
            </span>
          );
          const canOpenCert =
            canManage &&
            (row.hasCert || isBt) &&
            (row.websiteId != null || row.sslId != null || Boolean(row.siteName));
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
                  siteName: row.siteName,
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
        defaultWidth: 156,
        minWidth: 156,
        render: (row) => {
          const canAct = canManage && row.websiteId != null && Boolean(row.siteName);
          const busy = actionBusyId === row.websiteId;
          const running = isWebsiteRunning(row.status);
          const stopped = isWebsiteStopped(row.status);
          const canToggle = canAct && (running || stopped);
          const statusBusy = statusBusyId === row.websiteId;
          const actionLabel = running
            ? t("server.websites.stopWebsite")
            : t("server.websites.startWebsite");
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
                disabled={!canToggle || statusBusy || statusBusyId != null}
                title={
                  !canToggle
                    ? t("server.websites.panelOnly")
                    : statusBusy
                      ? t("server.websites.statusBusy")
                      : actionLabel
                }
                aria-label={
                  statusBusy ? t("server.websites.statusBusy") : actionLabel
                }
                onClick={() => void handleToggleStatus(row)}
              >
                {running ? <IconStop size={14} /> : <IconPlay size={14} />}
              </Button>
              <Button
                type="button"
                variant="icon"
                size="icon-xs"
                className="db-connection-info-deploy-action-btn"
                disabled={!canAct}
                title={canAct ? t("server.websites.logs") : t("server.websites.panelOnly")}
                aria-label={canAct ? t("server.websites.logs") : t("server.websites.panelOnly")}
                onClick={() => {
                  if (!canAct || row.websiteId == null || !row.siteName) return;
                  setAction({
                    kind: "logs",
                    websiteId: row.websiteId,
                    siteName: row.siteName,
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
                disabled={!canAct}
                title={canAct ? t("server.websites.config") : t("server.websites.panelOnly")}
                aria-label={canAct ? t("server.websites.config") : t("server.websites.panelOnly")}
                onClick={() => {
                  if (!canAct || row.websiteId == null || !row.siteName) return;
                  setAction({
                    kind: "config",
                    websiteId: row.websiteId,
                    siteName: row.siteName,
                    title: t("server.websites.configTitle", { name: row.domain }),
                  });
                }}
              >
                <IconSettings size={14} />
              </Button>
              <Button
                type="button"
                variant="icon"
                size="icon-xs"
                className="db-connection-info-deploy-action-btn"
                disabled={!canAct || busy}
                title={canAct ? t("server.websites.edit") : t("server.websites.panelOnly")}
                aria-label={canAct ? t("server.websites.edit") : t("server.websites.panelOnly")}
                onClick={() => handleEditWebsite(row)}
              >
                <IconPencil size={14} />
              </Button>
              <Button
                type="button"
                variant="danger"
                size="icon-xs"
                disabled={!canAct || busy || actionBusyId != null}
                title={canAct ? t("server.websites.delete") : t("server.websites.panelOnly")}
                aria-label={canAct ? t("server.websites.delete") : t("server.websites.panelOnly")}
                onClick={() => void handleDeleteWebsite(row)}
              >
                <IconTrash size={14} />
              </Button>
            </div>
          );
        },
      },
    ];
  }, [
    actionBusyId,
    canManage,
    formatWebsiteType,
    handleDeleteWebsite,
    handleEditWebsite,
    handleToggleStatus,
    isBt,
    statusBusyId,
    t,
  ]);

  const renderTable = () => {
    if ((loading || remoteLoading) && gridRows.length === 0) {
      return <div className="db-tables-panel-empty">{t("common.loading")}</div>;
    }
    if (error && gridRows.length === 0 && !remoteRows) {
      return <div className="db-tables-panel-error">{error}</div>;
    }
    if (gridRows.length === 0) {
      return <div className="db-tables-panel-empty">{t("server.websites.empty")}</div>;
    }
    if (sortedRows.length === 0) {
      return <div className="db-tables-panel-empty">{t("server.websites.filterEmpty")}</div>;
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
        // 网站行含操作按钮等 React 单元格；canvas 模式只绘文本，强制走 DOM host
        virtualizeRows={false}
        columnResizeStorageKey={`omnipanel.server.websites.column-widths.${server.id}.v5`}
      />
    );
  };

  const hasActiveFilters = Boolean(
    searchQuery || groupFilter || typeFilters.length > 0 || statusFilter || sslFilter,
  );
  const countLabel = hasActiveFilters
    ? t("server.websites.filteredCount", {
        filtered: sortedRows.length,
        total: rows.length,
      })
    : String(rows.length);

  const groupSelectOptions = useMemo(
    () => [
      { value: "", label: t("server.websites.allGroups") },
      ...(siteGroups ?? []).map((group) => ({
        value: group.id,
        label: group.name,
      })),
    ],
    [siteGroups, t],
  );

  const statusSelectOptions = useMemo(
    () => [
      { value: "", label: t("server.websites.allStatuses") },
      { value: "running", label: t("server.websites.statusRunning") },
      { value: "stopped", label: t("server.websites.statusStopped") },
    ],
    [t],
  );

  const sslSelectOptions = useMemo(
    () => [
      { value: "", label: t("server.websites.allSsl") },
      { value: "yes", label: t("server.websites.sslYes") },
      { value: "no", label: t("server.websites.sslNo") },
      { value: "expired", label: t("server.websites.certExpired") },
    ],
    [t],
  );

  const toggleTypeFilter = useCallback((type: string) => {
    setTypeFilters((prev) =>
      prev.includes(type) ? prev.filter((item) => item !== type) : [...prev, type],
    );
  }, []);

  const busy = loading || remoteLoading || refreshing;

  return (
    <div className="server-panel-tab server-websites-panel">
      <div className="server-panel-tab-toolbar">
        <span className="server-panel-tab-title">
          {t("server.tabs.websites")}
          <span className="badge badge-muted server-panel-tab-count">{countLabel}</span>
        </span>
        <div className="server-websites-toolbar-right">
          {typeOptions.length > 0 ? (
            <div
              className="server-websites-type-toggles"
              role="group"
              aria-label={t("server.websites.columns.type")}
            >
              {typeOptions.map((type) => {
                const active = typeFilters.includes(type);
                const label = formatWebsiteType(type);
                return (
                  <button
                    key={type}
                    type="button"
                    className={`server-websites-type-toggle${active ? " is-active" : ""}`}
                    aria-pressed={active}
                    title={label}
                    onClick={() => toggleTypeFilter(type)}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          ) : null}
          <div className="server-panel-tab-actions">
            <Button
              type="button"
              variant="icon"
              size="icon-xs"
              className="db-tables-panel-meta-refresh-btn"
              disabled={busy}
              title={busy ? t("server.refreshing") : t("server.refresh")}
              aria-label={busy ? t("server.refreshing") : t("server.refresh")}
              onClick={handleRefresh}
            >
              <IconRefresh size={14} />
            </Button>
            <Button
              type="button"
              variant="icon"
              size="icon-xs"
              disabled={!canManage || busy}
              title={canManage ? t("server.websites.create") : t("server.create.panelOnly")}
              aria-label={canManage ? t("server.websites.create") : t("server.create.panelOnly")}
              onClick={() => setCreateOpen(true)}
            >
              <IconPlus size={14} />
            </Button>
          </div>
        </div>
      </div>
      <div className="server-websites-filters">
        <div className="server-websites-filters__search">
          <TextInput
            className="input"
            value={searchInput}
            onChange={setSearchInput}
            placeholder={t("server.websites.searchPlaceholder")}
            onKeyDown={(event) => {
              if (event.key === "Enter") setSearchQuery(searchInput.trim());
            }}
          />
          <Button
            type="button"
            variant="icon"
            size="icon-xs"
            title={t("server.websites.search")}
            aria-label={t("server.websites.search")}
            onClick={() => setSearchQuery(searchInput.trim())}
          >
            <IconSearch size={14} />
          </Button>
        </div>
        <Select
          className="server-websites-filters__group"
          size="sm"
          value={groupFilter}
          onChange={setGroupFilter}
          options={groupSelectOptions}
          searchable={(siteGroups?.length ?? 0) > 8}
          aria-label={t("server.websites.columns.group")}
        />
        <Select
          className="server-websites-filters__group"
          size="sm"
          value={statusFilter}
          onChange={(value) => setStatusFilter(value as "" | "running" | "stopped")}
          options={statusSelectOptions}
          searchable={false}
          aria-label={t("server.websites.columns.status")}
        />
        <Select
          className="server-websites-filters__group"
          size="sm"
          value={sslFilter}
          onChange={(value) => setSslFilter(value as "" | "yes" | "no" | "expired")}
          options={sslSelectOptions}
          searchable={false}
          aria-label={t("server.websites.columns.certificate")}
        />
      </div>
      {(error && gridRows.length > 0) ||
      (certificatesError && gridRows.length > 0) ||
      statusError ||
      remoteError ? (
        <div className="db-tables-panel-error">
          {statusError ?? remoteError ?? error ?? certificatesError}
        </div>
      ) : null}
      <div ref={gridWrapRef} className="db-tables-panel-grid-wrap server-websites-grid-wrap">
        {renderTable()}
      </div>

      <WebsiteInfoSubWindow
        open={action?.kind === "info"}
        server={server}
        websiteId={action?.kind === "info" ? action.websiteId : null}
        siteName={action?.kind === "info" ? action.siteName : null}
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
        siteName={action?.kind === "logs" ? action.siteName : null}
        title={action?.kind === "logs" ? action.title : ""}
        onClose={() => setAction(null)}
      />
      <WebsiteConfigSubWindow
        open={action?.kind === "config"}
        server={server}
        websiteId={action?.kind === "config" ? action.websiteId : null}
        siteName={action?.kind === "config" ? action.siteName : null}
        title={action?.kind === "config" ? action.title : ""}
        onClose={() => setAction(null)}
      />
      <WebsiteCertSubWindow
        open={action?.kind === "cert"}
        server={server}
        websiteId={action?.kind === "cert" ? action.websiteId : null}
        siteName={action?.kind === "cert" ? action.siteName : null}
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
      <EditWebsiteDialog
        open={editTarget != null}
        server={server}
        websiteId={editTarget?.id ?? null}
        siteName={editTarget?.siteName ?? null}
        onClose={() => setEditTarget(null)}
        onUpdated={() => void refresh()}
      />
    </div>
  );
}
