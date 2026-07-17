import { useCallback, useMemo, useState } from "react";
import { useI18n } from "../../../../i18n";
import { Button } from "../../../../components/ui/primitives/Button";
import { IconDownload, IconFile, IconPencil, IconPlus, IconRefresh, IconTrash } from "../../../../components/ui/Icons";
import {
  DbTablesPanelGrid,
  type DbTablesPanelGridColumn,
  type DbTablesPanelGridSortDirection,
} from "../../../database/workspace/DbTablesPanelGrid";
import { createOnePanelClient } from "../../../../lib/onepanel";
import { appConfirm } from "../../../../lib/appConfirm";
import { showToast } from "../../../../stores/toastStore";
import { useServerPanelCacheStore } from "../../../../stores/serverPanelCacheStore";
import type { ServerEntry } from "../serverConnection";
import { useServerCertificates } from "../useServerCertificates";
import {
  certificateExpiryInfo,
  certificateNumericId,
  certificateRowAutoRenewEnabled,
  certificateRowId,
  certificateRowLabel,
  certificateRowProviderKey,
  certificateRowRemark,
  certificateRowStatus,
  certificateStatusBadgeClass,
  websiteCertificateDaysBadgeClass,
  websiteCertificateDaysBadgeStyle,
} from "../serverResourceLabels";
import { CreateCertificateDialog } from "../ServerResourceCreateDialogs";
import { CertificateLogsSubWindow } from "../WebsiteActionSubWindows";

interface Props {
  server: ServerEntry;
}

type CertSortColumn = "domain" | "status" | "provider" | "expire" | "autoRenew" | "remark";

type CertGridRow = {
  id: string;
  certId: number | null;
  domain: string;
  status: string;
  provider: string;
  remark: string;
  autoRenewEnabled: boolean | null;
  expireRaw: string | null;
  daysLeft: number | null;
};

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

function formatCertError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function ServerCertificatesTab({ server }: Props) {
  const { t } = useI18n();
  const { items: rows, loading, error, refresh } = useServerCertificates(server);
  const refreshing = useServerPanelCacheStore((s) =>
    Boolean(s.refreshingServerIds[server.id]),
  );
  const [sortColumn, setSortColumn] = useState<CertSortColumn>("domain");
  const [sortDirection, setSortDirection] = useState<DbTablesPanelGridSortDirection>("asc");
  const [createOpen, setCreateOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [logsTarget, setLogsTarget] = useState<{ sslId: number; title: string } | null>(null);
  const [actionBusyId, setActionBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const isOnePanel = server.serviceType === "1panel";

  const formatStatus = useCallback(
    (status: string) => {
      if (!status || status === "—") return "—";
      const key = status.trim().toLowerCase().replace(/[_-]/g, "");
      const known = new Set([
        "ready",
        "applying",
        "init",
        "error",
        "applyerror",
        "systemrestart",
      ]);
      if (known.has(key)) {
        return t(`server.certificates.statuses.${key}` as "server.certificates.statuses.ready");
      }
      return status;
    },
    [t],
  );

  const formatProvider = useCallback(
    (provider: string) => {
      if (!provider || provider === "—") return "—";
      const key = provider.trim();
      const known = new Set([
        "dnsAccount",
        "dnsManual",
        "http",
        "manual",
        "selfSigned",
        "fromMaster",
      ]);
      if (known.has(key)) {
        return t(
          `server.certificates.providers.${key}` as "server.certificates.providers.dnsAccount",
        );
      }
      return provider;
    },
    [t],
  );

  const gridRows = useMemo<CertGridRow[]>(
    () =>
      rows.map((row, index) => {
        const expire = certificateExpiryInfo(row);
        return {
          id: certificateRowId(row, index),
          certId: certificateNumericId(row),
          domain: certificateRowLabel(row),
          status: certificateRowStatus(row),
          provider: certificateRowProviderKey(row),
          remark: certificateRowRemark(row),
          autoRenewEnabled: certificateRowAutoRenewEnabled(row),
          expireRaw: expire.expireRaw,
          daysLeft: expire.daysLeft,
        };
      }),
    [rows],
  );

  const sortedRows = useMemo(() => {
    const next = [...gridRows];
    next.sort((a, b) => {
      if (sortColumn === "expire") {
        return compareNullableNumber(a.daysLeft, b.daysLeft, sortDirection);
      }
      if (sortColumn === "autoRenew") {
        const av = a.autoRenewEnabled == null ? -1 : a.autoRenewEnabled ? 1 : 0;
        const bv = b.autoRenewEnabled == null ? -1 : b.autoRenewEnabled ? 1 : 0;
        const cmp = av - bv;
        return sortDirection === "asc" ? cmp : -cmp;
      }
      if (sortColumn === "status") {
        return compareText(formatStatus(a.status), formatStatus(b.status), sortDirection);
      }
      if (sortColumn === "provider") {
        return compareText(formatProvider(a.provider), formatProvider(b.provider), sortDirection);
      }
      if (sortColumn === "remark") {
        return compareText(a.remark, b.remark, sortDirection);
      }
      return compareText(a[sortColumn], b[sortColumn], sortDirection);
    });
    return next;
  }, [formatProvider, formatStatus, gridRows, sortColumn, sortDirection]);

  const toggleSort = (columnId: string) => {
    const next = columnId as CertSortColumn;
    if (sortColumn === next) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }
    setSortColumn(next);
    setSortDirection("asc");
  };

  const handleEdit = useCallback((row: CertGridRow) => {
    if (row.certId == null) return;
    setEditId(row.certId);
  }, []);

  const handleDownload = useCallback(
    async (row: CertGridRow) => {
      if (!isOnePanel || row.certId == null || actionBusyId != null) return;
      setActionBusyId(row.certId);
      setActionError(null);
      try {
        const client = createOnePanelClient(server.address, server.key);
        const { filename, bytes } = await client.downloadWebsiteSsl(row.certId);
        const safeName =
          filename.trim() ||
          `${row.domain.replace(/[^\w.-]+/g, "_") || `ssl-${row.certId}`}.zip`;
        const blob = new Blob([bytes], { type: "application/zip" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = safeName;
        anchor.click();
        URL.revokeObjectURL(url);
        showToast(t("server.certificates.downloadSuccess"));
      } catch (err) {
        setActionError(formatCertError(err));
      } finally {
        setActionBusyId(null);
      }
    },
    [actionBusyId, isOnePanel, server.address, server.key, t],
  );

  const handleDelete = useCallback(
    async (row: CertGridRow) => {
      if (!isOnePanel || row.certId == null || actionBusyId != null) return;
      const confirmed = await appConfirm(
        t("server.certificates.deleteConfirm", { name: row.domain }),
      );
      if (!confirmed) return;
      setActionBusyId(row.certId);
      setActionError(null);
      try {
        const client = createOnePanelClient(server.address, server.key);
        await client.deleteWebsiteSsl([row.certId]);
        showToast(t("server.certificates.deleteSuccess"));
        await refresh();
      } catch (err) {
        setActionError(formatCertError(err));
      } finally {
        setActionBusyId(null);
      }
    },
    [actionBusyId, isOnePanel, refresh, server.address, server.key, t],
  );

  const handleToggleAutoRenew = useCallback(
    async (row: CertGridRow) => {
      if (!isOnePanel || row.certId == null || row.autoRenewEnabled == null || actionBusyId != null) {
        return;
      }
      const next = !row.autoRenewEnabled;
      setActionBusyId(row.certId);
      setActionError(null);
      try {
        const client = createOnePanelClient(server.address, server.key);
        await client.updateWebsiteSsl({
          id: row.certId,
          primaryDomain: row.domain,
          provider: row.provider === "—" ? "manual" : row.provider,
          autoRenew: next,
          description: row.remark,
        });
        showToast(
          next
            ? t("server.certificates.autoRenewEnabled")
            : t("server.certificates.autoRenewDisabled"),
        );
        await refresh();
      } catch (err) {
        setActionError(formatCertError(err));
      } finally {
        setActionBusyId(null);
      }
    },
    [actionBusyId, isOnePanel, refresh, server.address, server.key, t],
  );

  const columns = useMemo((): DbTablesPanelGridColumn<CertGridRow>[] => {
    return [
      {
        id: "domain",
        sortId: "domain",
        header: t("server.certificates.columns.domain"),
        sortable: true,
        nameCell: true,
        defaultWidth: 200,
        minWidth: 120,
        render: (row) => {
          const canDownload = isOnePanel && row.certId != null;
          const busy = actionBusyId === row.certId;
          return (
            <div className="server-resource-path-cell" onClick={(event) => event.stopPropagation()}>
              <span className="server-resource-path-text">{row.domain}</span>
              {canDownload ? (
                <Button
                  type="button"
                  variant="icon"
                  size="icon-xs"
                  className="db-connection-info-deploy-action-btn"
                  disabled={busy || actionBusyId != null}
                  title={t("server.certificates.download")}
                  aria-label={t("server.certificates.download")}
                  onClick={() => void handleDownload(row)}
                >
                  <IconDownload size={14} />
                </Button>
              ) : null}
            </div>
          );
        },
        getTitle: (row) => row.domain,
        getCopyValue: (row) => row.domain,
      },
      {
        id: "status",
        sortId: "status",
        header: t("server.certificates.columns.status"),
        sortable: true,
        defaultWidth: 100,
        minWidth: 72,
        render: (row) => {
          const label = formatStatus(row.status);
          return <span className={certificateStatusBadgeClass(row.status)}>{label}</span>;
        },
        getTitle: (row) => formatStatus(row.status),
        getCopyValue: (row) => formatStatus(row.status),
      },
      {
        id: "provider",
        sortId: "provider",
        header: t("server.certificates.columns.provider"),
        sortable: true,
        defaultWidth: 120,
        minWidth: 88,
        render: (row) => formatProvider(row.provider),
        getTitle: (row) => formatProvider(row.provider),
        getCopyValue: (row) => {
          const label = formatProvider(row.provider);
          return label === "—" ? undefined : label;
        },
      },
      {
        id: "expire",
        sortId: "expire",
        header: t("server.certificates.columns.expire"),
        sortable: true,
        defaultWidth: 120,
        minWidth: 88,
        render: (row) => {
          const label =
            row.daysLeft == null
              ? "—"
              : row.daysLeft < 0
                ? t("server.websites.certExpired")
                : row.daysLeft === 0
                  ? t("server.websites.certExpiresToday")
                  : t("server.websites.certDaysLeft", { days: row.daysLeft });
          return (
            <span
              className={websiteCertificateDaysBadgeClass(row.daysLeft)}
              style={websiteCertificateDaysBadgeStyle(row.daysLeft)}
              title={row.expireRaw ?? undefined}
            >
              {label}
            </span>
          );
        },
        getTitle: (row) => row.expireRaw ?? undefined,
        getCopyValue: (row) => row.expireRaw ?? undefined,
      },
      {
        id: "autoRenew",
        sortId: "autoRenew",
        header: t("server.certificates.columns.autoRenew"),
        sortable: true,
        defaultWidth: 88,
        minWidth: 72,
        render: (row) => {
          if (row.autoRenewEnabled == null) {
            return <span className="text-muted">—</span>;
          }
          const canToggle = isOnePanel && row.certId != null;
          const busy = actionBusyId === row.certId;
          const label = row.autoRenewEnabled
            ? t("server.certificates.autoRenewYes")
            : t("server.certificates.autoRenewNo");
          return (
            <button
              type="button"
              className={`toggle${row.autoRenewEnabled ? " on" : ""}${!canToggle || busy ? " toggle--disabled" : ""}`}
              role="switch"
              aria-checked={row.autoRenewEnabled}
              aria-label={label}
              title={label}
              disabled={!canToggle || busy || actionBusyId != null}
              onClick={(event) => {
                event.stopPropagation();
                void handleToggleAutoRenew(row);
              }}
            />
          );
        },
        getTitle: (row) =>
          row.autoRenewEnabled == null
            ? undefined
            : row.autoRenewEnabled
              ? t("server.certificates.autoRenewYes")
              : t("server.certificates.autoRenewNo"),
        getCopyValue: (row) =>
          row.autoRenewEnabled == null
            ? undefined
            : row.autoRenewEnabled
              ? t("server.certificates.autoRenewYes")
              : t("server.certificates.autoRenewNo"),
      },
      {
        id: "remark",
        sortId: "remark",
        header: t("server.certificates.columns.remark"),
        sortable: true,
        defaultWidth: 160,
        minWidth: 88,
        render: (row) => (
          <span className="text-muted">{row.remark || "—"}</span>
        ),
        getTitle: (row) => row.remark || undefined,
        getCopyValue: (row) => row.remark || undefined,
      },
      {
        id: "actions",
        header: t("server.certificates.columns.actions"),
        variant: "actionsSticky",
        copyable: false,
        resizable: false,
        defaultWidth: 108,
        minWidth: 108,
        render: (row) => {
          const canAct = isOnePanel && row.certId != null;
          const busy = actionBusyId === row.certId;
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
                disabled={!canAct || busy}
                title={canAct ? t("server.certificates.logs") : t("server.create.onePanelOnly")}
                aria-label={canAct ? t("server.certificates.logs") : t("server.create.onePanelOnly")}
                onClick={() => {
                  if (!canAct || row.certId == null) return;
                  setLogsTarget({
                    sslId: row.certId,
                    title: t("server.certificates.logsTitle", { name: row.domain }),
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
                disabled={!canAct || busy}
                title={canAct ? t("server.certificates.edit") : t("server.create.onePanelOnly")}
                aria-label={canAct ? t("server.certificates.edit") : t("server.create.onePanelOnly")}
                onClick={() => handleEdit(row)}
              >
                <IconPencil size={14} />
              </Button>
              <Button
                type="button"
                variant="danger"
                size="icon-xs"
                disabled={!canAct || busy || actionBusyId != null}
                title={canAct ? t("server.certificates.delete") : t("server.create.onePanelOnly")}
                aria-label={
                  canAct ? t("server.certificates.delete") : t("server.create.onePanelOnly")
                }
                onClick={() => void handleDelete(row)}
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
    formatProvider,
    formatStatus,
    handleDelete,
    handleDownload,
    handleEdit,
    handleToggleAutoRenew,
    isOnePanel,
    t,
  ]);

  const busy = loading || refreshing;

  const renderTable = () => {
    if (busy && gridRows.length === 0) {
      return <div className="db-tables-panel-empty">{t("common.loading")}</div>;
    }
    if ((error || actionError) && gridRows.length === 0) {
      return <div className="db-tables-panel-error">{actionError ?? error}</div>;
    }
    if (gridRows.length === 0) {
      return <div className="db-tables-panel-empty">{t("server.certificates.empty")}</div>;
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
        columnResizeStorageKey={`omnipanel.server.certificates.column-widths.${server.id}.v4`}
      />
    );
  };

  return (
    <div className="server-panel-tab server-websites-panel">
      <div className="server-panel-tab-toolbar">
        <span className="server-panel-tab-title">
          {t("server.tabs.certificates")}
          <span className="badge badge-muted server-panel-tab-count">{gridRows.length}</span>
        </span>
        <div className="server-panel-tab-actions">
          <Button
            type="button"
            variant="icon"
            size="icon-xs"
            className="db-tables-panel-meta-refresh-btn"
            disabled={busy}
            title={busy ? t("server.refreshing") : t("server.refresh")}
            aria-label={busy ? t("server.refreshing") : t("server.refresh")}
            onClick={() => void refresh()}
          >
            <IconRefresh size={14} />
          </Button>
          <Button
            type="button"
            variant="icon"
            size="icon-xs"
            disabled={!isOnePanel || busy}
            title={isOnePanel ? t("server.certificates.create") : t("server.create.onePanelOnly")}
            aria-label={isOnePanel ? t("server.certificates.create") : t("server.create.onePanelOnly")}
            onClick={() => setCreateOpen(true)}
          >
            <IconPlus size={14} />
          </Button>
        </div>
      </div>
      {(error || actionError) && gridRows.length > 0 ? (
        <div className="db-tables-panel-error">{actionError ?? error}</div>
      ) : null}
      <div className="db-tables-panel-grid-wrap server-websites-grid-wrap">{renderTable()}</div>
      <CreateCertificateDialog
        open={createOpen || editId != null}
        server={server}
        editId={editId}
        onClose={() => {
          setCreateOpen(false);
          setEditId(null);
        }}
        onCreated={() => void refresh()}
      />
      <CertificateLogsSubWindow
        open={logsTarget != null}
        server={server}
        sslId={logsTarget?.sslId ?? null}
        title={logsTarget?.title ?? ""}
        onClose={() => setLogsTarget(null)}
      />
    </div>
  );
}
