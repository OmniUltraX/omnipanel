import { useCallback, useEffect, useMemo, useState } from "react";
import { FormDialog } from "../../../components/ui/form/FormDialog";
import { TextInput } from "../../../components/ui/form/TextInput";
import { ImportPreview } from "../../../components/ui/ImportPreview";
import { useI18n } from "../../../i18n";
import { useSettingsStore } from "../../../stores/settingsStore";
import type { DbConnectionConfig } from "../api";
import { getEngineIconByType } from "./engineIcons";
import {
  computeImportPreviewRowState,
  previewItemToConnection,
  resolveImportConnectionName,
} from "../navicatImport/buildImportPreview";
import type { NavicatImportIssue, NavicatImportPreviewItem } from "../navicatImport/types";
import { saveConnection } from "../api";

interface ConnectionImportPreviewDialogProps {
  open: boolean;
  fileName: string;
  items: NavicatImportPreviewItem[];
  existingConnections: DbConnectionConfig[];
  onClose: () => void;
  onImported: () => void;
}

function issueLabel(
  issue: NavicatImportIssue,
  t: (key: string) => string,
): string {
  switch (issue) {
    case "unsupported_engine":
      return t("database.connectionImport.issueUnsupportedEngine");
    case "duplicate_name":
      return t("database.connectionImport.issueDuplicateName");
    case "duplicate_fingerprint":
      return t("database.connectionImport.issueDuplicateFingerprint");
    case "password_decrypt_failed":
      return t("database.connectionImport.issuePasswordFailed");
    case "missing_host":
      return t("database.connectionImport.issueMissingHost");
    default:
      return issue;
  }
}

export function ConnectionImportPreviewDialog({
  open,
  fileName,
  items,
  existingConnections,
  onClose,
  onImported,
}: ConnectionImportPreviewDialogProps) {
  const { t } = useI18n();
  const resolvedTheme = useSettingsStore((s) => s.resolved);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [customNames, setCustomNames] = useState<Record<string, string>>({});
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState<{ kind: "info" | "success" | "error"; message: string } | null>(
    null,
  );

  const columnLabels = useMemo(
    () => ({
      name: t("database.connectionImport.columnName"),
      engine: t("database.connectionImport.columnEngine"),
      host: t("database.connectionImport.columnHost"),
      user: t("database.connectionImport.columnUser"),
      database: t("database.connectionImport.columnDatabase"),
      status: t("database.connectionImport.columnStatus"),
    }),
    [t],
  );

  const rowStates = useMemo(() => {
    const namesForCompare = items.map((item) => ({
      id: item.id,
      name: resolveImportConnectionName(item, customNames[item.id]),
    }));
    const states = new Map<
      string,
      ReturnType<typeof computeImportPreviewRowState>
    >();
    for (const item of items) {
      states.set(
        item.id,
        computeImportPreviewRowState(
          item,
          customNames[item.id],
          existingConnections,
          namesForCompare,
        ),
      );
    }
    return states;
  }, [items, customNames, existingConnections]);

  const importableItems = useMemo(
    () => items.filter((item) => rowStates.get(item.id)?.importable),
    [items, rowStates],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    setCustomNames({});
    setSelectedIds(new Set(items.filter((item) => item.importable).map((item) => item.id)));
    setImporting(false);
    setStatus(null);
  }, [open, items]);

  const selectedCount = useMemo(
    () => importableItems.filter((item) => selectedIds.has(item.id)).length,
    [importableItems, selectedIds],
  );

  const updateCustomName = useCallback((id: string, value: string) => {
    setCustomNames((prev) => ({ ...prev, [id]: value }));
  }, []);

  const toggleItem = useCallback((id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);

  const toggleAllImportable = useCallback(
    (checked: boolean) => {
      setSelectedIds(
        checked ? new Set(importableItems.map((item) => item.id)) : new Set(),
      );
    },
    [importableItems],
  );

  const handleImport = useCallback(async () => {
    const toImport = importableItems.filter((item) => selectedIds.has(item.id));
    if (toImport.length === 0) {
      setStatus({ kind: "error", message: t("database.connectionImport.noSelection") });
      return;
    }

    setImporting(true);
    setStatus({ kind: "info", message: t("database.connectionImport.importing") });
    let success = 0;
    let failed = 0;
    for (const item of toImport) {
      try {
        await saveConnection(previewItemToConnection(item, customNames[item.id]));
        success += 1;
      } catch (err) {
        console.error("[db-import] saveConnection failed", item.raw.name, err);
        failed += 1;
      }
    }

    if (failed > 0) {
      setStatus({
        kind: "error",
        message: t("database.connectionImport.partialFailed", { success, failed }),
      });
      setImporting(false);
      if (success > 0) {
        onImported();
      }
      return;
    }

    setStatus({
      kind: "success",
      message: t("database.connectionImport.success", { count: success }),
    });
    setImporting(false);
    onImported();
    onClose();
  }, [customNames, importableItems, onClose, onImported, selectedIds, t]);

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={t("database.connectionImport.previewTitle")}
      subtitle={t("database.connectionImport.previewSubtitle", { file: fileName, count: items.length })}
      size="xl"
      className="db-import-preview-dialog"
      bodyClassName="db-import-preview-dialog__body"
      closeDisabled={importing}
      cancelDisabled={importing}
      status={status}
      primaryAction={{
        key: "import",
        label: t("database.connectionImport.confirm", { count: selectedCount }),
        disabled: importing || selectedCount === 0,
        onClick: () => void handleImport(),
      }}
    >
      <div className="db-import-preview-toolbar">
        <label className="db-import-preview-select-all">
          <input
            type="checkbox"
            checked={importableItems.length > 0 && selectedCount === importableItems.length}
            disabled={importing || importableItems.length === 0}
            onChange={(event) => toggleAllImportable(event.target.checked)}
          />
          <span>{t("database.connectionImport.selectAllImportable", { count: importableItems.length })}</span>
        </label>
      </div>

      <ImportPreview
        items={items.map((item) => {
          const rowState = rowStates.get(item.id);
          return {
            ...item,
            disabled: !(rowState?.importable ?? false) || importing,
          };
        })}
        selectedIds={selectedIds}
        selectAllLabel={t("database.connectionImport.selectAllImportable", {
          count: importableItems.length,
        })}
        onToggle={(id, next) => toggleItem(id, next)}
        columns={[
          {
            id: "name",
            header: columnLabels.name,
            width: 180,
            render: (item) => (
              <TextInput
                className="db-import-preview-name-input input"
                value={customNames[item.id] ?? item.raw.name}
                placeholder={t("database.connectionImport.namePlaceholder")}
                disabled={importing}
                onChange={(value) => updateCustomName(item.id, value)}
              />
            ),
          },
          {
            id: "engine",
            header: columnLabels.engine,
            width: 100,
            render: (item) => {
              const iconUrl = item.engine
                ? getEngineIconByType(item.engine, resolvedTheme)
                : null;
              return (
                <span className="db-import-preview-engine">
                  {iconUrl ? (
                    <img
                      src={iconUrl}
                      alt=""
                      className="db-import-preview-engine__icon"
                      width={14}
                      height={14}
                    />
                  ) : null}
                  <span>{item.raw.connType || "—"}</span>
                </span>
              );
            },
          },
          {
            id: "host",
            header: columnLabels.host,
            width: 160,
            render: (item) =>
              `${item.raw.host || "—"}${item.raw.port ? `:${item.raw.port}` : ""}`,
          },
          {
            id: "user",
            header: columnLabels.user,
            width: 100,
            render: (item) => item.raw.user || "—",
          },
          {
            id: "database",
            header: columnLabels.database,
            width: 120,
            render: (item) => item.raw.database || "—",
          },
          {
            id: "status",
            header: columnLabels.status,
            width: 140,
            render: (item) => {
              const issues = rowStates.get(item.id)?.issues ?? item.issues;
              if (issues.length === 0) {
                return (
                  <span className="db-import-preview-status db-import-preview-status--ready">
                    {t("database.connectionImport.statusReady")}
                  </span>
                );
              }
              return (
                <div className="db-import-preview-issues">
                  {issues.map((issue) => (
                    <span
                      key={issue}
                      className="db-import-preview-status db-import-preview-status--warn"
                    >
                      {issueLabel(issue, t)}
                    </span>
                  ))}
                </div>
              );
            },
          },
        ]}
      />
    </FormDialog>
  );
}
