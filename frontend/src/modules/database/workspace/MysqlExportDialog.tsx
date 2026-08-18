import { useCallback, useEffect, useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { FormDialog, FormField, Select, TextInput } from "../../../components/ui/form";
import { Button } from "../../../components/ui/primitives/Button";
import { useI18n } from "../../../i18n";
import {
  isConnectionEnabled,
  isMysqlConnectionInfoCapable,
  listDatabases,
  type DbConnectionConfig,
} from "../api";
import type { MysqlExportDestination } from "../mysqlExport";

export type MysqlExportDialogProps = {
  open: boolean;
  sourceConnection: DbConnectionConfig | null;
  sourceDatabase: string;
  connections: DbConnectionConfig[];
  submitting?: boolean;
  onClose: () => void;
  onConfirm: (destination: MysqlExportDestination) => void;
};

function defaultSqlFileName(databaseName: string): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${databaseName}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.sql`;
}

export function MysqlExportDialog({
  open,
  sourceConnection,
  sourceDatabase,
  connections,
  submitting = false,
  onClose,
  onConfirm,
}: MysqlExportDialogProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"local" | "clone">("local");
  const [destPath, setDestPath] = useState<string | null>(null);
  const [targetConnectionId, setTargetConnectionId] = useState("");
  const [targetDatabase, setTargetDatabase] = useState("");
  const [databases, setDatabases] = useState<string[]>([]);
  const [databasesLoading, setDatabasesLoading] = useState(false);
  const [databasesError, setDatabasesError] = useState<string | null>(null);

  const mysqlConnections = useMemo(
    () =>
      connections.filter(
        (connection) =>
          isMysqlConnectionInfoCapable(connection) && isConnectionEnabled(connection),
      ),
    [connections],
  );

  const targetConnection =
    mysqlConnections.find((connection) => connection.id === targetConnectionId) ?? null;

  const sourceConnectionName =
    sourceConnection?.name?.trim() ||
    sourceConnection?.host?.trim() ||
    sourceConnection?.id ||
    "";
  const sourceConnectionEndpoint = sourceConnection
    ? `${sourceConnection.host}:${sourceConnection.port}`
    : "";
  const sourceConnectionUser = sourceConnection?.user?.trim() ?? "";
  const sourceConnectionHint = [
    sourceConnectionEndpoint,
    sourceConnectionUser ? t("database.export.sourceUser", { user: sourceConnectionUser }) : "",
  ]
    .filter(Boolean)
    .join(" · ");

  useEffect(() => {
    if (!open) {
      return;
    }
    setMode("local");
    setDestPath(null);
    setDatabases([]);
    setDatabasesError(null);
    const preferred =
      mysqlConnections.find((connection) => connection.id !== sourceConnection?.id) ??
      mysqlConnections[0] ??
      null;
    setTargetConnectionId(preferred?.id ?? "");
    setTargetDatabase(sourceDatabase);
  }, [open, sourceConnection?.id, sourceDatabase]);

  useEffect(() => {
    if (!open || mode !== "clone" || !targetConnection) {
      return;
    }
    let disposed = false;
    setDatabasesLoading(true);
    setDatabasesError(null);
    void listDatabases(targetConnection, { quiet: true })
      .then((names) => {
        if (disposed) return;
        const list = Array.isArray(names) ? names : [];
        setDatabases(list);
        setTargetDatabase((current) => {
          if (current && (list.includes(current) || current === sourceDatabase)) {
            return current;
          }
          if (list.includes(sourceDatabase)) {
            return sourceDatabase;
          }
          return list[0] ?? sourceDatabase;
        });
      })
      .catch((error) => {
        if (disposed) return;
        setDatabases([]);
        setDatabasesError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!disposed) {
          setDatabasesLoading(false);
        }
      });
    return () => {
      disposed = true;
    };
  }, [open, mode, targetConnection, sourceDatabase]);

  const handlePickPath = useCallback(async () => {
    const picked = await save({
      title: t("database.export.pickPathTitle"),
      defaultPath: destPath ?? defaultSqlFileName(sourceDatabase),
      filters: [{ name: "SQL", extensions: ["sql"] }],
    });
    if (!picked) {
      return null;
    }
    setDestPath(picked);
    return picked;
  }, [destPath, sourceDatabase, t]);

  const sameTarget =
    Boolean(sourceConnection) &&
    targetConnection?.id === sourceConnection?.id &&
    targetDatabase.trim() === sourceDatabase;

  const canSubmit =
    !submitting &&
    (mode === "local" ||
      (Boolean(targetConnection) && Boolean(targetDatabase.trim()) && !sameTarget));

  const databaseOptions = useMemo(() => {
    const names = new Set(databases);
    if (sourceDatabase && !names.has(sourceDatabase)) {
      names.add(sourceDatabase);
    }
    if (targetDatabase.trim()) {
      names.add(targetDatabase.trim());
    }
    return [...names].sort((a, b) => a.localeCompare(b)).map((name) => ({
      value: name,
      label: databases.includes(name)
        ? name
        : t("database.export.databaseWillCreate", { name }),
    }));
  }, [databases, sourceDatabase, t, targetDatabase]);

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={t("database.export.dialogTitle", { database: sourceDatabase })}
      subtitle={t("database.export.dialogSubtitle")}
      size="md"
      cancelDisabled={submitting}
      closeDisabled={submitting}
      primaryAction={{
        label: submitting ? t("database.export.submitting") : t("database.export.confirm"),
        disabled: !canSubmit,
        onClick: () => {
          if (mode === "local") {
            void (async () => {
              const path = destPath ?? (await handlePickPath());
              if (!path) {
                return;
              }
              onConfirm({ kind: "local", destPath: path });
            })();
            return;
          }
          if (!targetConnection || !targetDatabase.trim() || sameTarget) {
            return;
          }
          onConfirm({
            kind: "clone",
            targetConnection,
            targetDatabase: targetDatabase.trim(),
          });
        },
      }}
    >
        <div className="mysql-export-dialog">
          <div className="mysql-export-dialog__pair">
            <FormField
              label={t("database.export.sourceConnection")}
              hint={sourceConnectionHint || undefined}
            >
              <TextInput
                value={sourceConnectionName}
                disabled
                clearable={false}
                copyable={false}
                size="sm"
              />
            </FormField>
            <FormField label={t("database.export.sourceDatabase")}>
              <TextInput
                value={sourceDatabase}
                disabled
                clearable={false}
                copyable={false}
                size="sm"
              />
            </FormField>
          </div>
          <div className="form-radio-group mysql-export-dialog__modes">
            <label className="form-radio-option">
              <input
                type="radio"
                name="mysql-export-mode"
                checked={mode === "local"}
                disabled={submitting}
                onChange={() => setMode("local")}
              />
              {t("database.export.modeLocal")}
            </label>
            <label className="form-radio-option">
              <input
                type="radio"
                name="mysql-export-mode"
                checked={mode === "clone"}
                disabled={submitting}
                onChange={() => setMode("clone")}
              />
              {t("database.export.modeClone")}
            </label>
          </div>

          {mode === "local" ? (
            <div className="mysql-export-dialog__section">
              <div className="mysql-export-dialog__section-head">
                <span>{t("database.export.localPathLabel")}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={submitting}
                  onClick={() => void handlePickPath()}
                >
                  {t("database.export.pickPath")}
                </Button>
              </div>
              <p className="mysql-export-dialog__hint">
                {destPath ?? t("database.export.noPathSelected")}
              </p>
            </div>
          ) : mysqlConnections.length === 0 ? (
            <p className="mysql-export-dialog__hint mysql-export-dialog__hint--error">
              {t("database.export.noMysqlConnections")}
            </p>
          ) : (
            <div className="mysql-export-dialog__pair">
              <FormField label={t("database.export.targetConnection")}>
                <Select
                  className="mysql-export-dialog__select"
                  value={targetConnectionId}
                  onChange={setTargetConnectionId}
                  options={mysqlConnections.map((connection) => ({
                    value: connection.id,
                    label: connection.name || connection.host || connection.id,
                    subtitle: `${connection.host}:${connection.port}`,
                  }))}
                  searchable
                  size="sm"
                  disabled={submitting}
                />
              </FormField>
              <FormField
                label={t("database.export.targetDatabase")}
                hint={
                  sameTarget
                    ? t("database.export.sameTarget")
                    : databasesError
                      ? databasesError
                      : databasesLoading
                        ? t("common.loading")
                        : targetDatabase.trim() && !databases.includes(targetDatabase.trim())
                          ? t("database.export.databaseWillCreate", { name: targetDatabase.trim() })
                          : undefined
                }
              >
                <Select
                  className="mysql-export-dialog__select"
                  value={targetDatabase}
                  onChange={setTargetDatabase}
                  options={databaseOptions}
                  searchable
                  allowCustom
                  formatCustomOption={(name) =>
                    t("database.export.databaseWillCreate", { name })
                  }
                  size="sm"
                  disabled={submitting || !targetConnection || databasesLoading}
                  emptyText={t("database.export.noDatabases")}
                  searchPlaceholder={t("database.export.databaseSearchPlaceholder")}
                />
              </FormField>
            </div>
          )}
        </div>
    </FormDialog>
  );
}
