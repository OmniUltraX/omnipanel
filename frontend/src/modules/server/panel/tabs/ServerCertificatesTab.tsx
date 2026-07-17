import { useCallback, useMemo, useState } from "react";
import { useI18n } from "../../../../i18n";
import { Button } from "../../../../components/ui/primitives/Button";
import { IconPlus, IconRefresh } from "../../../../components/ui/Icons";
import {
  DbTablesPanelGrid,
  type DbTablesPanelGridColumn,
  type DbTablesPanelGridSortDirection,
} from "../../../database/workspace/DbTablesPanelGrid";
import { useServerPanelCacheStore } from "../../../../stores/serverPanelCacheStore";
import type { ServerEntry } from "../serverConnection";
import { useServerCertificates } from "../useServerCertificates";
import {
  certificateExpiryInfo,
  certificateRowAutoRenew,
  certificateRowId,
  certificateRowLabel,
  certificateRowProvider,
  websiteCertificateDaysBadgeClass,
  websiteCertificateDaysBadgeStyle,
} from "../serverResourceLabels";
import { CreateCertificateDialog } from "../ServerResourceCreateDialogs";

interface Props {
  server: ServerEntry;
}

type CertSortColumn = "domain" | "provider" | "expire" | "autoRenew";

type CertGridRow = {
  id: string;
  domain: string;
  provider: string;
  autoRenew: string;
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

export function ServerCertificatesTab({ server }: Props) {
  const { t } = useI18n();
  const { items: rows, loading, error, refresh } = useServerCertificates(server);
  const refreshing = useServerPanelCacheStore((s) =>
    Boolean(s.refreshingServerIds[server.id]),
  );
  const [sortColumn, setSortColumn] = useState<CertSortColumn>("domain");
  const [sortDirection, setSortDirection] = useState<DbTablesPanelGridSortDirection>("asc");
  const [createOpen, setCreateOpen] = useState(false);
  const isOnePanel = server.serviceType === "1panel";

  const formatAutoRenew = useCallback(
    (value: string) => {
      if (value === "true" || value === "1" || value.toLowerCase() === "yes") {
        return t("server.certificates.autoRenewYes");
      }
      if (value === "false" || value === "0" || value.toLowerCase() === "no") {
        return t("server.certificates.autoRenewNo");
      }
      if (value === "—") return "—";
      return value;
    },
    [t],
  );

  const gridRows = useMemo<CertGridRow[]>(
    () =>
      rows.map((row, index) => {
        const expire = certificateExpiryInfo(row);
        return {
          id: certificateRowId(row, index),
          domain: certificateRowLabel(row),
          provider: certificateRowProvider(row),
          autoRenew: certificateRowAutoRenew(row),
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
        return compareText(formatAutoRenew(a.autoRenew), formatAutoRenew(b.autoRenew), sortDirection);
      }
      return compareText(a[sortColumn], b[sortColumn], sortDirection);
    });
    return next;
  }, [formatAutoRenew, gridRows, sortColumn, sortDirection]);

  const toggleSort = (columnId: string) => {
    const next = columnId as CertSortColumn;
    if (sortColumn === next) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }
    setSortColumn(next);
    setSortDirection("asc");
  };

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
        render: (row) => row.domain,
        getTitle: (row) => row.domain,
        getCopyValue: (row) => row.domain,
      },
      {
        id: "provider",
        sortId: "provider",
        header: t("server.certificates.columns.provider"),
        sortable: true,
        defaultWidth: 140,
        minWidth: 88,
        render: (row) => row.provider,
        getTitle: (row) => row.provider,
        getCopyValue: (row) => (row.provider === "—" ? undefined : row.provider),
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
        defaultWidth: 100,
        minWidth: 72,
        render: (row) => {
          const label = formatAutoRenew(row.autoRenew);
          const yes = label === t("server.certificates.autoRenewYes");
          const no = label === t("server.certificates.autoRenewNo");
          const cls = yes ? "badge badge-success" : no ? "badge badge-muted" : "badge badge-accent";
          return <span className={cls}>{label}</span>;
        },
        getTitle: (row) => formatAutoRenew(row.autoRenew),
        getCopyValue: (row) => formatAutoRenew(row.autoRenew),
      },
    ];
  }, [formatAutoRenew, t]);

  const busy = loading || refreshing;

  const renderTable = () => {
    if (busy && gridRows.length === 0) {
      return <div className="db-tables-panel-empty">{t("common.loading")}</div>;
    }
    if (error && gridRows.length === 0) {
      return <div className="db-tables-panel-error">{error}</div>;
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
        columnResizeStorageKey={`omnipanel.server.certificates.column-widths.${server.id}.v1`}
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
      {error && gridRows.length > 0 ? <div className="db-tables-panel-error">{error}</div> : null}
      <div className="db-tables-panel-grid-wrap server-websites-grid-wrap">{renderTable()}</div>
      <CreateCertificateDialog
        open={createOpen}
        server={server}
        onClose={() => setCreateOpen(false)}
        onCreated={() => void refresh()}
      />
    </div>
  );
}
