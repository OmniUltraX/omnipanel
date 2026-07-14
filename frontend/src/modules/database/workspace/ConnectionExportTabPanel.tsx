import { useCallback, useEffect, useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { useI18n } from "../../../i18n";
import { appConfirm } from "../../../lib/appConfirm";
import { showToast } from "../../../stores/toastStore";
import type { DbConnectionConfig } from "../api";
import {
  deleteMysqlExport,
  formatExportFileSize,
  listMysqlExports,
  listenMysqlExportEvents,
  saveMysqlExportAs,
  type MysqlExportRecord,
} from "../mysqlExport";
import { DbTablesPanelGrid, type DbTablesPanelGridColumn } from "./DbTablesPanelGrid";
import { Button } from "../../../components/ui/primitives/Button";

interface ConnectionExportTabPanelProps {
  connection: DbConnectionConfig;
  active: boolean;
  refreshToken?: number;
  onRecordsChange?: (count: number) => void;
}

function formatExportTime(timestamp: number, locale: string): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "—";
  }
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp));
}

function exportStatusLabel(
  record: MysqlExportRecord,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  switch (record.status) {
    case "running":
      return t("database.connectionInfo.exports.statusRunning");
    case "completed":
      return t("database.connectionInfo.exports.statusCompleted");
    case "failed": {
      const reason = record.error?.trim();
      if (reason) {
        return t("database.connectionInfo.exports.statusFailedWithReason", { error: reason });
      }
      return t("database.connectionInfo.exports.statusFailed");
    }
    default:
      return record.status;
  }
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M8 2v8M5 7l3 3 3-3" />
      <path d="M3 12h10" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M3 4h10M6 4V3h4v1M5 4l.5 9h5L11 4" />
    </svg>
  );
}

export function ConnectionExportTabPanel({
  connection,
  active,
  refreshToken = 0,
  onRecordsChange,
}: ConnectionExportTabPanelProps) {
  const { t, locale } = useI18n();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exports, setExports] = useState<MysqlExportRecord[]>([]);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const refreshExports = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setLoading(true);
    }
    setError(null);
    try {
      const records = await listMysqlExports(connection.id);
      setExports(Array.isArray(records) ? records : []);
      onRecordsChange?.(Array.isArray(records) ? records.length : 0);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
    } finally {
      if (!options?.silent) {
        setLoading(false);
      }
    }
  }, [connection.id, onRecordsChange]);

  useEffect(() => {
    if (!active) {
      return;
    }
    void refreshExports();
  }, [active, refreshExports, refreshToken]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenMysqlExportEvents(connection.id, () => {
      if (disposed) {
        return;
      }
      void refreshExports({ silent: true });
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [connection.id, refreshExports]);

  const handleDownload = useCallback(
    async (record: MysqlExportRecord) => {
      if (record.status !== "completed") {
        return;
      }
      const defaultPath = `${record.databaseName}-${record.id}.sql`;
      const destPath = await save({
        title: t("database.connectionInfo.exports.downloadTitle"),
        defaultPath,
        filters: [{ name: "SQL", extensions: ["sql"] }],
      });
      if (!destPath) {
        return;
      }
      setDownloadingId(record.id);
      try {
        await saveMysqlExportAs(connection.id, record.id, destPath);
        showToast(t("database.connectionInfo.exports.downloadDone"));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        showToast(message || t("database.connectionInfo.exports.downloadFailed"));
      } finally {
        setDownloadingId(null);
      }
    },
    [connection.id, t],
  );

  const handleDelete = useCallback(
    async (record: MysqlExportRecord) => {
      if (record.status === "running") {
        return;
      }
      const confirmed = await appConfirm(
        t("database.connectionInfo.exports.deleteConfirmMessage", {
          database: record.databaseName,
        }),
        t("database.connectionInfo.exports.deleteConfirmTitle"),
        {
          confirmLabel: t("database.connectionInfo.exports.delete"),
          cancelLabel: t("common.cancel"),
        },
      );
      if (!confirmed) {
        return;
      }
      setDeletingId(record.id);
      try {
        await deleteMysqlExport(connection.id, record.id);
        showToast(t("database.connectionInfo.exports.deleteDone"));
        await refreshExports({ silent: true });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        showToast(message || t("database.connectionInfo.exports.deleteFailed"));
      } finally {
        setDeletingId(null);
      }
    },
    [connection.id, refreshExports, t],
  );

  const columns = useMemo<DbTablesPanelGridColumn<MysqlExportRecord>[]>(
    () => [
      {
        id: "databaseName",
        header: t("database.connectionInfo.exports.columnDatabase"),
        nameCell: true,
        render: (record) => record.databaseName,
        getTitle: (record) => record.databaseName,
      },
      {
        id: "createdAt",
        header: t("database.connectionInfo.exports.columnTime"),
        render: (record) => formatExportTime(record.createdAt, locale),
        getTitle: (record) => formatExportTime(record.createdAt, locale),
      },
      {
        id: "fileSize",
        header: t("database.connectionInfo.exports.columnSize"),
        render: (record) => formatExportFileSize(record.fileSize),
        getTitle: (record) => formatExportFileSize(record.fileSize),
      },
      {
        id: "status",
        header: t("database.connectionInfo.exports.columnStatus"),
        render: (record) => exportStatusLabel(record, t),
        getTitle: (record) => {
          const label = exportStatusLabel(record, t);
          const reason = record.status === "failed" ? record.error?.trim() : "";
          return reason && !label.includes(reason) ? `${label}\n${reason}` : label;
        },
      },
      {
        id: "actions",
        variant: "actionsSticky",
        header: t("database.connectionInfo.exports.columnActions"),
        headerAriaLabel: t("database.connectionInfo.exports.columnActions"),
        render: (record) => {
          const busy = downloadingId === record.id || deletingId === record.id;
          return (
            <div className="db-tables-panel-grid__row-actions">
              <Button
                type="button"
                variant="icon"
                size="icon-xs"
                title={t("database.connectionInfo.exports.download")}
                aria-label={t("database.connectionInfo.exports.download")}
                disabled={record.status !== "completed" || busy}
                onClick={(event) => {
                  event.stopPropagation();
                  void handleDownload(record);
                }}
              >
                <DownloadIcon />
              </Button>
              <Button
                type="button"
                variant="icon"
                size="icon-xs"
                className="db-tables-panel-grid__action-danger"
                title={t("database.connectionInfo.exports.delete")}
                aria-label={t("database.connectionInfo.exports.delete")}
                disabled={record.status === "running" || busy}
                onClick={(event) => {
                  event.stopPropagation();
                  void handleDelete(record);
                }}
              >
                <DeleteIcon />
              </Button>
            </div>
          );
        },
      },
    ],
    [deletingId, downloadingId, handleDelete, handleDownload, locale, t],
  );

  if (error) {
    return (
      <div className="db-tables-panel-empty">
        {error}
      </div>
    );
  }

  if (loading && exports.length === 0) {
    return <div className="db-tables-panel-empty">{t("common.loading")}</div>;
  }

  if (exports.length === 0) {
    return (
      <div className="db-tables-panel-empty">
        {t("database.connectionInfo.exports.empty")}
      </div>
    );
  }

  return (
    <DbTablesPanelGrid
      rows={exports}
      rowKey={(record) => record.id}
      columns={columns}
    />
  );
}
