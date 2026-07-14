import { useCallback, useEffect, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { FormDialog } from "../../../components/ui/FormDialog";
import { Button } from "../../../components/ui/primitives/Button";
import { useI18n } from "../../../i18n";
import type { DbConnectionConfig } from "../api";
import {
  formatExportFileSize,
  listMysqlExports,
  type MysqlExportRecord,
} from "../mysqlExport";
import type { MysqlImportSource } from "../mysqlImport";

export type MysqlImportDialogProps = {
  open: boolean;
  connection: DbConnectionConfig | null;
  databaseName: string;
  submitting?: boolean;
  onClose: () => void;
  onConfirm: (source: MysqlImportSource) => void;
};

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
  }).format(new Date(timestamp));
}

export function MysqlImportDialog({
  open,
  connection,
  databaseName,
  submitting = false,
  onClose,
  onConfirm,
}: MysqlImportDialogProps) {
  const { t, locale } = useI18n();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exports, setExports] = useState<MysqlExportRecord[]>([]);
  const [selectedExportId, setSelectedExportId] = useState<string | null>(null);
  const [localFilePath, setLocalFilePath] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !connection) {
      return;
    }
    let disposed = false;
    setLoading(true);
    setError(null);
    setSelectedExportId(null);
    setLocalFilePath(null);
    void listMysqlExports(connection.id)
      .then((records) => {
        if (disposed) return;
        const completed = (Array.isArray(records) ? records : []).filter(
          (record) => record.status === "completed",
        );
        setExports(completed);
      })
      .catch((e) => {
        if (disposed) return;
        setError(e instanceof Error ? e.message : String(e));
        setExports([]);
      })
      .finally(() => {
        if (!disposed) {
          setLoading(false);
        }
      });
    return () => {
      disposed = true;
    };
  }, [connection, open]);

  const handlePickFile = useCallback(async () => {
    const picked = await openFileDialog({
      title: t("database.import.pickFileTitle"),
      multiple: false,
      filters: [{ name: "SQL", extensions: ["sql"] }],
    });
    if (!picked || typeof picked !== "string") {
      return;
    }
    setLocalFilePath(picked);
    setSelectedExportId(null);
  }, [t]);

  const canSubmit = Boolean(localFilePath || selectedExportId) && !submitting;

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={t("database.import.dialogTitle", { database: databaseName })}
      subtitle={t("database.import.dialogSubtitle")}
      size="md"
      cancelDisabled={submitting}
      primaryAction={{
        label: submitting ? t("database.import.submitting") : t("database.import.confirm"),
        disabled: !canSubmit,
        onClick: () => {
          if (localFilePath) {
            onConfirm({ kind: "file", filePath: localFilePath });
            return;
          }
          if (selectedExportId) {
            onConfirm({ kind: "export", exportId: selectedExportId });
          }
        },
      }}
    >
      <div className="mysql-import-dialog">
        <div className="mysql-import-dialog__section">
          <div className="mysql-import-dialog__section-head">
            <span>{t("database.import.fromFile")}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={submitting}
              onClick={() => void handlePickFile()}
            >
              {t("database.import.pickFile")}
            </Button>
          </div>
          <p className="mysql-import-dialog__hint">
            {localFilePath
              ? localFilePath
              : t("database.import.noFileSelected")}
          </p>
        </div>

        <div className="mysql-import-dialog__section">
          <div className="mysql-import-dialog__section-head">
            <span>{t("database.import.fromExport")}</span>
          </div>
          {loading ? (
            <p className="mysql-import-dialog__hint">{t("common.loading")}</p>
          ) : error ? (
            <p className="mysql-import-dialog__hint mysql-import-dialog__hint--error">{error}</p>
          ) : exports.length === 0 ? (
            <p className="mysql-import-dialog__hint">{t("database.import.noExports")}</p>
          ) : (
            <ul className="mysql-import-dialog__list">
              {exports.map((record) => {
                const checked = selectedExportId === record.id && !localFilePath;
                return (
                  <li key={record.id}>
                    <label className={`mysql-import-dialog__item${checked ? " is-selected" : ""}`}>
                      <input
                        type="radio"
                        name="mysql-import-source"
                        checked={checked}
                        disabled={submitting}
                        onChange={() => {
                          setSelectedExportId(record.id);
                          setLocalFilePath(null);
                        }}
                      />
                      <span className="mysql-import-dialog__item-main">
                        <span className="mysql-import-dialog__item-title">
                          {record.databaseName}
                        </span>
                        <span className="mysql-import-dialog__item-meta">
                          {formatExportTime(record.createdAt, locale)}
                          {" · "}
                          {formatExportFileSize(record.fileSize)}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </FormDialog>
  );
}
