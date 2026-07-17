import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../../../i18n";
import { Button } from "../../../../components/ui/primitives/Button";
import { IconPlus, IconRefresh } from "../../../../components/ui/Icons";
import {
  DbTablesPanelGrid,
  type DbTablesPanelGridColumn,
  type DbTablesPanelGridSortDirection,
} from "../../../database/workspace/DbTablesPanelGrid";
import { createOnePanelClient } from "../../../../lib/onepanel";
import { createBtPanelClient } from "../../../../lib/btpanel";
import type { ServerEntry } from "../serverConnection";
import {
  cronjobRowId,
  cronjobRowName,
  cronjobRowSchedule,
  cronjobRowStatus,
  cronjobRowType,
  websiteStatusBadgeClass,
} from "../serverResourceLabels";
import { CreateCronjobDialog } from "../ServerResourceCreateDialogs";

interface Props {
  server: ServerEntry;
}

type CronSortColumn = "name" | "schedule" | "status" | "type";

type CronGridRow = {
  id: string;
  name: string;
  schedule: string;
  status: string;
  type: string;
};

function compareText(a: string, b: string, direction: DbTablesPanelGridSortDirection): number {
  const cmp = a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
  return direction === "asc" ? cmp : -cmp;
}

export function ServerCronjobsTab({ server }: Props) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [sortColumn, setSortColumn] = useState<CronSortColumn>("name");
  const [sortDirection, setSortDirection] = useState<DbTablesPanelGridSortDirection>("asc");
  const [createOpen, setCreateOpen] = useState(false);
  const isOnePanel = server.serviceType === "1panel";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (server.serviceType === "1panel") {
        const client = createOnePanelClient(server.address, server.key);
        const items = await client.searchCronjobs();
        setRows(items as Record<string, unknown>[]);
      } else {
        const client = createBtPanelClient(server.address, server.key);
        const result = await client.getCronList({ limit: 100 });
        setRows(result.data as unknown as Record<string, unknown>[]);
      }
    } catch (e) {
      setError(String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [server.address, server.key, server.serviceType]);

  useEffect(() => {
    void load();
  }, [load, server.id]);

  const gridRows = useMemo<CronGridRow[]>(
    () =>
      rows.map((row, index) => ({
        id: cronjobRowId(row, index),
        name: cronjobRowName(row),
        schedule: cronjobRowSchedule(row),
        status: cronjobRowStatus(row),
        type: cronjobRowType(row),
      })),
    [rows],
  );

  const sortedRows = useMemo(() => {
    const next = [...gridRows];
    next.sort((a, b) => compareText(a[sortColumn], b[sortColumn], sortDirection));
    return next;
  }, [gridRows, sortColumn, sortDirection]);

  const toggleSort = (columnId: string) => {
    const next = columnId as CronSortColumn;
    if (sortColumn === next) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }
    setSortColumn(next);
    setSortDirection("asc");
  };

  const columns = useMemo((): DbTablesPanelGridColumn<CronGridRow>[] => {
    return [
      {
        id: "name",
        sortId: "name",
        header: t("server.cronjobs.columns.name"),
        sortable: true,
        nameCell: true,
        defaultWidth: 180,
        minWidth: 120,
        render: (row) => row.name,
        getTitle: (row) => row.name,
        getCopyValue: (row) => row.name,
      },
      {
        id: "schedule",
        sortId: "schedule",
        header: t("server.cronjobs.columns.schedule"),
        sortable: true,
        defaultWidth: 160,
        minWidth: 100,
        render: (row) => row.schedule,
        getTitle: (row) => row.schedule,
        getCopyValue: (row) => (row.schedule === "—" ? undefined : row.schedule),
      },
      {
        id: "type",
        sortId: "type",
        header: t("server.cronjobs.columns.type"),
        sortable: true,
        defaultWidth: 100,
        minWidth: 72,
        render: (row) => <span className="badge badge-muted">{row.type}</span>,
        getTitle: (row) => row.type,
        getCopyValue: (row) => (row.type === "—" ? undefined : row.type),
      },
      {
        id: "status",
        sortId: "status",
        header: t("server.cronjobs.columns.status"),
        sortable: true,
        defaultWidth: 100,
        minWidth: 72,
        render: (row) => (
          <span className={websiteStatusBadgeClass(row.status)}>{row.status}</span>
        ),
        getTitle: (row) => row.status,
        getCopyValue: (row) => row.status,
      },
    ];
  }, [t]);

  const renderTable = () => {
    if (loading && gridRows.length === 0) {
      return <div className="db-tables-panel-empty">{t("common.loading")}</div>;
    }
    if (error && gridRows.length === 0) {
      return <div className="db-tables-panel-error">{error}</div>;
    }
    if (gridRows.length === 0) {
      return <div className="db-tables-panel-empty">{t("server.cronjobs.empty")}</div>;
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
        columnResizeStorageKey={`omnipanel.server.cronjobs.column-widths.${server.id}.v1`}
      />
    );
  };

  return (
    <div className="server-panel-tab server-websites-panel">
      <div className="server-panel-tab-toolbar">
        <span className="server-panel-tab-title">
          {t("server.tabs.cronjobs")}
          <span className="badge badge-muted server-panel-tab-count">{gridRows.length}</span>
        </span>
        <Button
          type="button"
          variant="icon"
          size="icon-xs"
          disabled={!isOnePanel || loading}
          title={isOnePanel ? t("server.cronjobs.create") : t("server.create.onePanelOnly")}
          aria-label={isOnePanel ? t("server.cronjobs.create") : t("server.create.onePanelOnly")}
          onClick={() => setCreateOpen(true)}
        >
          <IconPlus size={14} />
        </Button>
        <Button
          type="button"
          variant="icon"
          size="icon-xs"
          className="db-tables-panel-meta-refresh-btn"
          disabled={loading}
          title={loading ? t("server.refreshing") : t("server.refresh")}
          aria-label={loading ? t("server.refreshing") : t("server.refresh")}
          onClick={() => void load()}
        >
          <IconRefresh size={14} />
        </Button>
      </div>
      {error && gridRows.length > 0 ? <div className="db-tables-panel-error">{error}</div> : null}
      <div className="db-tables-panel-grid-wrap server-websites-grid-wrap">{renderTable()}</div>
      <CreateCronjobDialog
        open={createOpen}
        server={server}
        onClose={() => setCreateOpen(false)}
        onCreated={() => void load()}
      />
    </div>
  );
}
