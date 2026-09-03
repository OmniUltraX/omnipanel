import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../../../i18n";
import { Button } from "../../../../components/ui/primitives/Button";
import { TextInput } from "../../../../components/ui/form/TextInput";
import {
  IconPencil,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconStop,
  IconTrash,
} from "../../../../components/ui/Icons";
import {
  DbTablesPanelGrid,
  type DbTablesPanelGridColumn,
  type DbTablesPanelGridSortDirection,
} from "../../../database/workspace/DbTablesPanelGrid";
import {
  getPanelDriver,
  hasInprocPanelDriver,
  panelConnectionCtx,
} from "../../../../lib/panelDriverRegistry";
import { appConfirm } from "../../../../lib/appConfirm";
import { showToast } from "../../../../stores/toastStore";
import type { ServerEntry } from "../serverConnection";
import {
  panelHasCapability,
  panelTabCreateSpec,
} from "../panelPlugin";
import {
  cronjobNumericId,
  cronjobRowId,
  cronjobRowName,
  cronjobRowSchedule,
  cronjobRowStatus,
  cronjobRowType,
  websiteStatusBadgeClass,
} from "../serverResourceLabels";
import { CreateCronjobDialog } from "../ServerResourceCreateDialogs";
import { PluginFormDialog } from "../PluginFormDialog";

interface Props {
  server: ServerEntry;
}

type CronSortColumn = "name" | "schedule" | "status" | "type";

type CronGridRow = {
  id: string;
  jobId: number | null;
  name: string;
  schedule: string;
  status: string;
  type: string;
};

function compareText(a: string, b: string, direction: DbTablesPanelGridSortDirection): number {
  const cmp = a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
  return direction === "asc" ? cmp : -cmp;
}

function formatCronError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isCronEnabled(status: string): boolean {
  const key = status.trim().toLowerCase();
  return key === "enable" || key === "enabled" || key === "1" || key === "true";
}

function isCronDisabled(status: string): boolean {
  const key = status.trim().toLowerCase();
  return key === "disable" || key === "disabled" || key === "0" || key === "false";
}

export function ServerCronjobsTab({ server }: Props) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [sortColumn, setSortColumn] = useState<CronSortColumn>("name");
  const [sortDirection, setSortDirection] = useState<DbTablesPanelGridSortDirection>("asc");
  const [createOpen, setCreateOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [actionBusyId, setActionBusyId] = useState<number | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const driver = getPanelDriver(server.serviceType);
  const inproc = hasInprocPanelDriver(server.serviceType);
  const canManage = panelHasCapability(server.serviceType, "cronjobs");
  const pluginCreate = panelTabCreateSpec(server.serviceType, "cronjobs");
  const canCreate =
    canManage && (Boolean(pluginCreate) || (inproc && typeof driver?.createCronjob === "function"));
  const canEdit = canManage && inproc;
  const canToggle = canManage && typeof driver?.setCronjobStatus === "function";
  const canRun = canManage && typeof driver?.runCronjob === "function";
  const canDelete = canManage && typeof driver?.deleteCronjob === "function";

  useEffect(() => {
    const timer = window.setTimeout(() => setSearchQuery(searchInput.trim()), 280);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const load = useCallback(async (opts?: { soft?: boolean }) => {
    if (!opts?.soft) setLoading(true);
    setError(null);
    try {
      const next = getPanelDriver(server.serviceType);
      setRows(next?.listCronjobs ? await next.listCronjobs(panelConnectionCtx(server)) : []);
    } catch (e) {
      setError(String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [server.address, server.id, server.key, server.serviceType]);

  useEffect(() => {
    void load();
  }, [load, server.id]);

  const gridRows = useMemo<CronGridRow[]>(
    () =>
      rows.map((row, index) => ({
        id: cronjobRowId(row, index),
        jobId: cronjobNumericId(row),
        name: cronjobRowName(row),
        schedule: cronjobRowSchedule(row),
        status: cronjobRowStatus(row),
        type: cronjobRowType(row),
      })),
    [rows],
  );

  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return gridRows;
    return gridRows.filter((row) => {
      const haystack = [row.name, row.type, row.schedule, row.status].join(" ").toLowerCase();
      return haystack.includes(q);
    });
  }, [gridRows, searchQuery]);

  const sortedRows = useMemo(() => {
    const next = [...filteredRows];
    next.sort((a, b) => compareText(a[sortColumn], b[sortColumn], sortDirection));
    return next;
  }, [filteredRows, sortColumn, sortDirection]);

  const toggleSort = (columnId: string) => {
    const next = columnId as CronSortColumn;
    if (sortColumn === next) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }
    setSortColumn(next);
    setSortDirection("asc");
  };

  const handleEdit = useCallback((row: CronGridRow) => {
    if (row.jobId == null) return;
    setEditId(row.jobId);
  }, []);

  const handleToggleStatus = useCallback(
    async (row: CronGridRow) => {
      if (!canToggle || row.jobId == null || actionBusyId != null) return;
      const enabled = isCronEnabled(row.status);
      const disabled = isCronDisabled(row.status);
      if (!enabled && !disabled) return;

      setActionBusyId(row.jobId);
      setError(null);
      try {
        const next = getPanelDriver(server.serviceType);
        if (!next?.setCronjobStatus) return;
        await next.setCronjobStatus(panelConnectionCtx(server), {
          id: row.jobId,
          enabled: !enabled,
        });
        showToast(enabled ? t("server.cronjobs.disableSuccess") : t("server.cronjobs.enableSuccess"));
        await load({ soft: true });
      } catch (err) {
        setError(formatCronError(err));
      } finally {
        setActionBusyId(null);
      }
    },
    [actionBusyId, canToggle, load, server, t],
  );

  const handleRunOnce = useCallback(
    async (row: CronGridRow) => {
      if (!canRun || row.jobId == null || actionBusyId != null) return;
      setActionBusyId(row.jobId);
      setError(null);
      try {
        const next = getPanelDriver(server.serviceType);
        if (!next?.runCronjob) return;
        await next.runCronjob(panelConnectionCtx(server), { id: row.jobId });
        showToast(t("server.cronjobs.runOnceSuccess", { name: row.name }));
      } catch (err) {
        setError(formatCronError(err));
      } finally {
        setActionBusyId(null);
      }
    },
    [actionBusyId, canRun, server, t],
  );

  const handleDelete = useCallback(
    async (row: CronGridRow) => {
      if (!canDelete || row.jobId == null || actionBusyId != null) return;
      const confirmed = await appConfirm(
        t("server.cronjobs.deleteConfirm", { name: row.name }),
      );
      if (!confirmed) return;
      setActionBusyId(row.jobId);
      setError(null);
      try {
        const next = getPanelDriver(server.serviceType);
        if (!next?.deleteCronjob) return;
        await next.deleteCronjob(panelConnectionCtx(server), { id: row.jobId });
        showToast(t("server.cronjobs.deleteSuccess"));
        await load({ soft: true });
      } catch (err) {
        setError(formatCronError(err));
      } finally {
        setActionBusyId(null);
      }
    },
    [actionBusyId, canDelete, load, server, t],
  );

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
      {
        id: "actions",
        header: t("server.cronjobs.columns.actions"),
        variant: "actionsSticky",
        copyable: false,
        resizable: false,
        defaultWidth: 132,
        minWidth: 132,
        render: (row) => {
          const hasId = row.jobId != null;
          const busy = actionBusyId === row.jobId;
          const enabled = isCronEnabled(row.status);
          const disabled = isCronDisabled(row.status);
          const canToggleRow = canToggle && hasId && (enabled || disabled);
          const canRunRow = canRun && hasId;
          const canDeleteRow = canDelete && hasId;
          const canEditRow = canEdit && hasId;
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
                disabled={!canRunRow || busy || actionBusyId != null}
                title={canRunRow ? t("server.cronjobs.runOnce") : t("server.create.panelOnly")}
                aria-label={canRunRow ? t("server.cronjobs.runOnce") : t("server.create.panelOnly")}
                onClick={() => void handleRunOnce(row)}
              >
                <IconPlay size={14} />
              </Button>
              <Button
                type="button"
                variant="icon"
                size="icon-xs"
                className="db-connection-info-deploy-action-btn"
                disabled={!canToggleRow || busy || actionBusyId != null}
                title={
                  !canToggleRow
                    ? t("server.create.panelOnly")
                    : enabled
                      ? t("server.cronjobs.disable")
                      : t("server.cronjobs.enable")
                }
                aria-label={
                  enabled ? t("server.cronjobs.disable") : t("server.cronjobs.enable")
                }
                onClick={() => void handleToggleStatus(row)}
              >
                {enabled ? <IconStop size={14} /> : <IconPlay size={14} />}
              </Button>
              <Button
                type="button"
                variant="icon"
                size="icon-xs"
                className="db-connection-info-deploy-action-btn"
                disabled={!canEditRow || busy}
                title={canEditRow ? t("server.cronjobs.edit") : t("server.create.panelOnly")}
                aria-label={canEditRow ? t("server.cronjobs.edit") : t("server.create.panelOnly")}
                onClick={() => handleEdit(row)}
              >
                <IconPencil size={14} />
              </Button>
              <Button
                type="button"
                variant="danger"
                size="icon-xs"
                disabled={!canDeleteRow || busy || actionBusyId != null}
                title={canDeleteRow ? t("server.cronjobs.delete") : t("server.create.panelOnly")}
                aria-label={canDeleteRow ? t("server.cronjobs.delete") : t("server.create.panelOnly")}
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
    canDelete,
    canEdit,
    canRun,
    canToggle,
    handleDelete,
    handleEdit,
    handleRunOnce,
    handleToggleStatus,
    t,
  ]);

  const countLabel = searchQuery
    ? t("server.cronjobs.filteredCount", {
        filtered: sortedRows.length,
        total: gridRows.length,
      })
    : String(gridRows.length);

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
    if (sortedRows.length === 0) {
      return <div className="db-tables-panel-empty">{t("server.cronjobs.filterEmpty")}</div>;
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
        columnResizeStorageKey={`omnipanel.server.cronjobs.column-widths.${server.id}.v3`}
      />
    );
  };

  return (
    <div className="server-panel-tab server-websites-panel">
      <div className="server-panel-tab-toolbar">
        <span className="server-panel-tab-title">
          {t("server.tabs.cronjobs")}
          <span className="badge badge-muted server-panel-tab-count">{countLabel}</span>
        </span>
        <div className="server-panel-tab-actions">
          <Button
            type="button"
            variant="icon"
            size="icon-xs"
            className="db-tables-panel-meta-refresh-btn"
            disabled={loading}
            title={loading ? t("server.refreshing") : t("server.refresh")}
            aria-label={loading ? t("server.refreshing") : t("server.refresh")}
            onClick={() => void load({ soft: rows.length > 0 })}
          >
            <IconRefresh size={14} />
          </Button>
          <Button
            type="button"
            variant="icon"
            size="icon-xs"
            disabled={!canCreate || loading}
            title={canCreate ? t("server.cronjobs.create") : t("server.create.panelOnly")}
            aria-label={canCreate ? t("server.cronjobs.create") : t("server.create.panelOnly")}
            onClick={() => setCreateOpen(true)}
          >
            <IconPlus size={14} />
          </Button>
        </div>
      </div>
      <div className="server-websites-filters">
        <div className="server-websites-filters__search">
          <TextInput
            className="input"
            value={searchInput}
            onChange={setSearchInput}
            placeholder={t("server.cronjobs.searchPlaceholder")}
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
      </div>
      {error && gridRows.length > 0 ? <div className="db-tables-panel-error">{error}</div> : null}
      <div className="db-tables-panel-grid-wrap server-websites-grid-wrap">{renderTable()}</div>
      <CreateCronjobDialog
        open={(createOpen && inproc && !pluginCreate) || (editId != null && inproc)}
        server={server}
        editId={editId}
        onClose={() => {
          setCreateOpen(false);
          setEditId(null);
        }}
        onCreated={() => void load({ soft: true })}
      />
      <PluginFormDialog
        open={createOpen && Boolean(pluginCreate)}
        title={t("server.cronjobs.create")}
        fields={pluginCreate?.formFields ?? []}
        onClose={() => setCreateOpen(false)}
        onSubmit={async (values) => {
          const driver = getPanelDriver(server.serviceType);
          if (!driver?.createCronjob) throw new Error(t("server.create.panelOnly"));
          await driver.createCronjob(panelConnectionCtx(server), values);
          showToast(t("server.cronjobs.createSuccess"));
          await load({ soft: true });
        }}
      />
    </div>
  );
}
