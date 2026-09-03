import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../../../i18n";
import { Button } from "../../../../components/ui/primitives/Button";
import { IconPlus, IconRefresh, IconTrash } from "../../../../components/ui/Icons";
import {
  DbTablesPanelGrid,
  type DbTablesPanelGridColumn,
  type DbTablesPanelGridSortDirection,
} from "../../../database/workspace/DbTablesPanelGrid";
import { appConfirm } from "../../../../lib/appConfirm";
import {
  getPanelDriver,
  hasInprocPanelDriver,
  panelConnectionCtx,
  type PanelDatabaseItem,
} from "../../../../lib/panelDriverRegistry";
import { showToast } from "../../../../stores/toastStore";
import type { ServerEntry } from "../serverConnection";
import { panelHasCapability, panelTabCreateSpec } from "../panelPlugin";
import { CreateDatabaseDialog } from "../CreateDatabaseDialog";
import { PluginFormDialog } from "../PluginFormDialog";

interface Props {
  server: ServerEntry;
}

type DbSortColumn = "name" | "user" | "type" | "remark";

type DbGridRow = PanelDatabaseItem & { rowKey: string };

function compareText(a: string, b: string, direction: DbTablesPanelGridSortDirection): number {
  const cmp = a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
  return direction === "asc" ? cmp : -cmp;
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function ServerDatabasesTab({ server }: Props) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<PanelDatabaseItem[]>([]);
  const [sortColumn, setSortColumn] = useState<DbSortColumn>("name");
  const [sortDirection, setSortDirection] = useState<DbTablesPanelGridSortDirection>("asc");
  const [createOpen, setCreateOpen] = useState(false);
  const [actionBusyId, setActionBusyId] = useState<number | null>(null);

  const driver = getPanelDriver(server.serviceType);
  const inproc = hasInprocPanelDriver(server.serviceType);
  const canManage = panelHasCapability(server.serviceType, "databases") && driver != null;
  const pluginCreate = panelTabCreateSpec(server.serviceType, "databases");
  const canCreate =
    canManage &&
    (Boolean(pluginCreate) || (inproc && typeof driver?.createDatabase === "function"));
  const canDelete = canManage && typeof driver?.deleteDatabase === "function";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = getPanelDriver(server.serviceType);
      if (!next) {
        throw new Error(t("server.create.panelOnly"));
      }
      setRows(await next.listDatabases(panelConnectionCtx(server)));
    } catch (e) {
      setError(formatError(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [server.address, server.id, server.key, server.serviceType, t]);

  useEffect(() => {
    void load();
  }, [load, server.id]);

  const gridRows = useMemo<DbGridRow[]>(
    () =>
      rows.map((row, index) => ({
        ...row,
        rowKey: String(row.id ?? index),
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
      const next = getPanelDriver(server.serviceType);
      if (!canDelete || !next?.deleteDatabase || row.id == null || actionBusyId != null) return;
      const confirmed = await appConfirm(
        t("server.databases.deleteConfirm", { name: row.name }),
      );
      if (!confirmed) return;
      setActionBusyId(row.id);
      setError(null);
      try {
        await next.deleteDatabase(panelConnectionCtx(server), {
          id: row.id,
          name: row.name,
          dbUser: row.user === "—" ? row.name : row.user,
          type: row.type,
        });
        showToast(t("server.databases.deleteSuccess"));
        await load();
      } catch (err) {
        setError(formatError(err));
      } finally {
        setActionBusyId(null);
      }
    },
    [actionBusyId, canDelete, load, server, t],
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
          const canAct = canDelete && row.id != null;
          const busy = actionBusyId === row.id;
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
  }, [actionBusyId, canDelete, handleDelete, t]);

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
            disabled={!canCreate || loading}
            title={canCreate ? t("server.databases.create") : t("server.create.panelOnly")}
            aria-label={canCreate ? t("server.databases.create") : t("server.create.panelOnly")}
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
            rowKey={(row) => row.rowKey}
            sortColumnId={sortColumn}
            sortDirection={sortDirection}
            onSortColumn={toggleSort}
            columnResizeStorageKey={`omnipanel.server.databases.column-widths.${server.id}.v1`}
          />
        )}
      </div>
      <CreateDatabaseDialog
        open={createOpen && inproc && !pluginCreate}
        server={server}
        onClose={() => setCreateOpen(false)}
        onCreated={() => void load()}
      />
      <PluginFormDialog
        open={createOpen && Boolean(pluginCreate)}
        title={t("server.databases.create")}
        fields={pluginCreate?.formFields ?? []}
        onClose={() => setCreateOpen(false)}
        onSubmit={async (values) => {
          const next = getPanelDriver(server.serviceType);
          if (!next?.createDatabase) throw new Error(t("server.create.panelOnly"));
          await next.createDatabase(panelConnectionCtx(server), {
            name: values.name ?? "",
            dbUser: values.dbUser || values.user || values.name || "",
            password: values.password ?? "",
            charset: values.charset,
            remark: values.remark,
          });
          showToast(t("server.databases.createSuccess"));
          await load();
        }}
      />
    </div>
  );
}
