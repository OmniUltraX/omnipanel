import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../../../i18n";
import { Button } from "../../../../components/ui/primitives/Button";
import { IconPlus, IconRefresh, IconTrash } from "../../../../components/ui/Icons";
import {
  DbTablesPanelGrid,
  type DbTablesPanelGridColumn,
  type DbTablesPanelGridSortDirection,
} from "../../../database/workspace/DbTablesPanelGrid";
import { createOnePanelClient } from "../../../../lib/onepanel";
import { createBtPanelClient } from "../../../../lib/btpanel";
import { appConfirm } from "../../../../lib/appConfirm";
import { showToast } from "../../../../stores/toastStore";
import type { ServerEntry } from "../serverConnection";
import { CreateDatabaseDialog } from "../CreateDatabaseDialog";

interface Props {
  server: ServerEntry;
}

type DbSortColumn = "name" | "user" | "type" | "remark";

type DbGridRow = {
  id: string;
  dbId: number | null;
  name: string;
  user: string;
  type: string;
  remark: string;
};

function compareText(a: string, b: string, direction: DbTablesPanelGridSortDirection): number {
  const cmp = a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
  return direction === "asc" ? cmp : -cmp;
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function rowName(row: Record<string, unknown>): string {
  return String(row.name ?? row.database ?? row.dbName ?? "—");
}

function rowUser(row: Record<string, unknown>): string {
  return String(row.username ?? row.user ?? row.db_user ?? row.name ?? "—");
}

function rowType(row: Record<string, unknown>): string {
  return String(row.type ?? row.dbType ?? "MySQL");
}

function rowRemark(row: Record<string, unknown>): string {
  return String(row.ps ?? row.remark ?? row.description ?? "");
}

function rowId(row: Record<string, unknown>): number | null {
  const raw = row.id;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  return null;
}

export function ServerDatabasesTab({ server }: Props) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [sortColumn, setSortColumn] = useState<DbSortColumn>("name");
  const [sortDirection, setSortDirection] = useState<DbTablesPanelGridSortDirection>("asc");
  const [createOpen, setCreateOpen] = useState(false);
  const [actionBusyId, setActionBusyId] = useState<number | null>(null);

  const isBt = server.serviceType === "bt";
  const canManage = isBt;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (server.serviceType === "1panel") {
        const client = createOnePanelClient(server.address, server.key);
        const items = await client.searchDatabases();
        setRows(items as Record<string, unknown>[]);
      } else {
        const client = createBtPanelClient(server.address, server.key);
        const result = await client.getDatabaseList({ limit: 100 });
        setRows(result.data);
      }
    } catch (e) {
      setError(formatError(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [server.address, server.key, server.serviceType]);

  useEffect(() => {
    void load();
  }, [load, server.id]);

  const gridRows = useMemo<DbGridRow[]>(
    () =>
      rows.map((row, index) => ({
        id: String(row.id ?? index),
        dbId: rowId(row),
        name: rowName(row),
        user: rowUser(row),
        type: rowType(row),
        remark: rowRemark(row),
      })),
    [rows],
  );

  const sortedRows = useMemo(() => {
    const next = [...gridRows];
    next.sort((a, b) => compareText(a[sortColumn], b[sortColumn], sortDirection));
    return next;
  }, [gridRows, sortColumn, sortDirection]);

  const toggleSort = (columnId: string) => {
    const next = columnId as DbSortColumn;
    if (sortColumn === next) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }
    setSortColumn(next);
    setSortDirection("asc");
  };

  const handleDelete = useCallback(
    async (row: DbGridRow) => {
      if (!canManage || row.dbId == null || actionBusyId != null) return;
      const confirmed = await appConfirm(
        t("server.databases.deleteConfirm", { name: row.name }),
      );
      if (!confirmed) return;
      setActionBusyId(row.dbId);
      setError(null);
      try {
        const client = createBtPanelClient(server.address, server.key);
        await client.deleteDatabase({
          id: row.dbId,
          name: row.name,
          dbUser: row.user === "—" ? row.name : row.user,
        });
        showToast(t("server.databases.deleteSuccess"));
        await load();
      } catch (err) {
        setError(formatError(err));
      } finally {
        setActionBusyId(null);
      }
    },
    [actionBusyId, canManage, load, server.address, server.key, t],
  );

  const columns = useMemo((): DbTablesPanelGridColumn<DbGridRow>[] => {
    return [
      {
        id: "name",
        sortId: "name",
        header: t("server.databases.columns.name"),
        sortable: true,
        nameCell: true,
        defaultWidth: 180,
        minWidth: 120,
        render: (row) => row.name,
        getTitle: (row) => row.name,
        getCopyValue: (row) => row.name,
      },
      {
        id: "user",
        sortId: "user",
        header: t("server.databases.columns.user"),
        sortable: true,
        defaultWidth: 140,
        minWidth: 100,
        render: (row) => row.user,
        getTitle: (row) => row.user,
        getCopyValue: (row) => row.user,
      },
      {
        id: "type",
        sortId: "type",
        header: t("server.databases.columns.type"),
        sortable: true,
        defaultWidth: 100,
        minWidth: 72,
        render: (row) => <span className="badge badge-muted">{row.type}</span>,
        getTitle: (row) => row.type,
        getCopyValue: (row) => row.type,
      },
      {
        id: "remark",
        sortId: "remark",
        header: t("server.databases.columns.remark"),
        sortable: true,
        defaultWidth: 180,
        minWidth: 100,
        render: (row) => <span className="text-muted">{row.remark || "—"}</span>,
        getTitle: (row) => row.remark || undefined,
        getCopyValue: (row) => row.remark || undefined,
      },
      {
        id: "actions",
        header: t("server.databases.columns.actions"),
        variant: "actionsSticky",
        copyable: false,
        resizable: false,
        defaultWidth: 72,
        minWidth: 64,
        render: (row) => {
          const canAct = canManage && row.dbId != null;
          const busy = actionBusyId === row.dbId;
          return (
            <div
              className="db-tables-panel-grid__row-actions"
              onClick={(event) => event.stopPropagation()}
            >
              <Button
                type="button"
                variant="danger"
                size="icon-xs"
                disabled={!canAct || busy || actionBusyId != null}
                title={canAct ? t("server.databases.delete") : t("server.create.panelOnly")}
                aria-label={canAct ? t("server.databases.delete") : t("server.create.panelOnly")}
                onClick={() => void handleDelete(row)}
              >
                <IconTrash size={14} />
              </Button>
            </div>
          );
        },
      },
    ];
  }, [actionBusyId, canManage, handleDelete, t]);

  return (
    <div className="server-panel-tab">
      <div className="server-panel-tab-toolbar">
        <span className="server-panel-tab-title">
          {t("server.tabs.databases")}
          <span className="badge badge-muted server-panel-tab-count">{gridRows.length}</span>
        </span>
        <div className="server-panel-tab-actions">
          <Button
            type="button"
            variant="icon"
            size="icon-xs"
            disabled={loading}
            title={loading ? t("server.refreshing") : t("server.refresh")}
            aria-label={loading ? t("server.refreshing") : t("server.refresh")}
            onClick={() => void load()}
          >
            <IconRefresh size={14} />
          </Button>
          <Button
            type="button"
            variant="icon"
            size="icon-xs"
            disabled={!canManage || loading}
            title={canManage ? t("server.databases.create") : t("server.create.panelOnly")}
            aria-label={canManage ? t("server.databases.create") : t("server.create.panelOnly")}
            onClick={() => setCreateOpen(true)}
          >
            <IconPlus size={14} />
          </Button>
        </div>
      </div>
      {error ? <div className="db-tables-panel-error">{error}</div> : null}
      <div className="db-tables-panel-grid-wrap">
        {loading && gridRows.length === 0 ? (
          <div className="db-tables-panel-empty">{t("common.loading")}</div>
        ) : gridRows.length === 0 ? (
          <div className="db-tables-panel-empty">{t("server.databases.empty")}</div>
        ) : (
          <DbTablesPanelGrid
            variant="processlist"
            columns={columns}
            rows={sortedRows}
            rowKey={(row) => row.id}
            sortColumnId={sortColumn}
            sortDirection={sortDirection}
            onSortColumn={toggleSort}
            columnResizeStorageKey={`omnipanel.server.databases.column-widths.${server.id}.v1`}
          />
        )}
      </div>
      <CreateDatabaseDialog
        open={createOpen}
        server={server}
        onClose={() => setCreateOpen(false)}
        onCreated={() => void load()}
      />
    </div>
  );
}
