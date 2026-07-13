import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { FormDialog } from "../../../components/ui/form/FormDialog";
import { TextInput } from "../../../components/ui/form/TextInput";
import { useResizableTableColumns } from "../../../components/ui/table/useResizableTableColumns";
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
      return t("database.import.issueUnsupportedEngine");
    case "duplicate_name":
      return t("database.import.issueDuplicateName");
    case "duplicate_fingerprint":
      return t("database.import.issueDuplicateFingerprint");
    case "password_decrypt_failed":
      return t("database.import.issuePasswordFailed");
    case "missing_host":
      return t("database.import.issueMissingHost");
    default:
      return issue;
  }
}

const IMPORT_PREVIEW_COLUMNS = [
  { id: "select", defaultWidth: 40, minWidth: 36, resizable: false as const },
  { id: "name", defaultWidth: 180, minWidth: 120 },
  { id: "engine", defaultWidth: 100, minWidth: 72 },
  { id: "host", defaultWidth: 160, minWidth: 100 },
  { id: "user", defaultWidth: 100, minWidth: 72 },
  { id: "database", defaultWidth: 120, minWidth: 80 },
  { id: "status", defaultWidth: 140, minWidth: 96 },
] as const;

const IMPORT_PREVIEW_COLUMN_STORAGE_KEY = "omnipanel-db-import-preview-col-widths";

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
  const {
    tableRef,
    resizingColumnId,
    getColumnStyle,
    startColumnResize,
    isColumnResizable,
  } = useResizableTableColumns([...IMPORT_PREVIEW_COLUMNS], {
    storageKey: IMPORT_PREVIEW_COLUMN_STORAGE_KEY,
  });

  const columnLabels = useMemo(
    () => ({
      select: t("database.import.columnSelect"),
      name: t("database.import.columnName"),
      engine: t("database.import.columnEngine"),
      host: t("database.import.columnHost"),
      user: t("database.import.columnUser"),
      database: t("database.import.columnDatabase"),
      status: t("database.import.columnStatus"),
    }),
    [t],
  );

  const renderHeaderCell = (columnId: (typeof IMPORT_PREVIEW_COLUMNS)[number]["id"]) => (
    <th
      key={columnId}
      data-col-id={columnId}
      style={getColumnStyle(columnId)}
      className={resizingColumnId === columnId ? "db-import-preview-th--resizing" : undefined}
      aria-label={columnId === "select" ? columnLabels.select : undefined}
    >
      {columnId === "select" ? null : columnLabels[columnId]}
      {isColumnResizable(columnId) ? (
        <div
          className="db-import-preview-col-resize"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            startColumnResize(columnId, event.clientX);
          }}
        />
      ) : null}
    </th>
  );

  const renderBodyCell = (
    columnId: (typeof IMPORT_PREVIEW_COLUMNS)[number]["id"],
    content: ReactNode,
    className?: string,
  ) => (
    <td
      key={columnId}
      data-col-id={columnId}
      style={getColumnStyle(columnId)}
      className={className}
      title={typeof content === "string" ? content : undefined}
    >
      {content}
    </td>
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
      setStatus({ kind: "error", message: t("database.import.noSelection") });
      return;
    }

    setImporting(true);
    setStatus({ kind: "info", message: t("database.import.importing") });
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
        message: t("database.import.partialFailed", { success, failed }),
      });
      setImporting(false);
      if (success > 0) {
        onImported();
      }
      return;
    }

    setStatus({
      kind: "success",
      message: t("database.import.success", { count: success }),
    });
    setImporting(false);
    onImported();
    onClose();
  }, [customNames, importableItems, onClose, onImported, selectedIds, t]);

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={t("database.import.previewTitle")}
      subtitle={t("database.import.previewSubtitle", { file: fileName, count: items.length })}
      size="xl"
      className="db-import-preview-dialog"
      bodyClassName="db-import-preview-dialog__body"
      closeDisabled={importing}
      cancelDisabled={importing}
      status={status}
      primaryAction={{
        key: "import",
        label: t("database.import.confirm", { count: selectedCount }),
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
          <span>{t("database.import.selectAllImportable", { count: importableItems.length })}</span>
        </label>
      </div>

      <div
        className={`db-import-preview-table-wrap${resizingColumnId ? " db-import-preview-table-wrap--col-resizing" : ""}`}
      >
        <table
          ref={tableRef}
          className={`db-import-preview-table${resizingColumnId ? " db-import-preview-table--resizing" : ""}`}
        >
          <colgroup>
            {IMPORT_PREVIEW_COLUMNS.map((column) => (
              <col key={column.id} data-col-id={column.id} style={getColumnStyle(column.id)} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {IMPORT_PREVIEW_COLUMNS.map((column) => renderHeaderCell(column.id))}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const rowState = rowStates.get(item.id);
              const importable = rowState?.importable ?? false;
              const issues = rowState?.issues ?? item.issues;
              const iconUrl = item.engine
                ? getEngineIconByType(item.engine, resolvedTheme)
                : null;
              const displayName = customNames[item.id] ?? item.raw.name;
              const hostText = `${item.raw.host || "—"}${item.raw.port ? `:${item.raw.port}` : ""}`;
              return (
                <tr
                  key={item.id}
                  className={`db-import-preview-row${importable ? "" : " db-import-preview-row--disabled"}`}
                >
                  {renderBodyCell(
                    "select",
                    <input
                      type="checkbox"
                      checked={selectedIds.has(item.id)}
                      disabled={!importable || importing}
                      onChange={(event) => toggleItem(item.id, event.target.checked)}
                    />,
                    "db-import-preview-cell--select",
                  )}
                  {renderBodyCell(
                    "name",
                    <TextInput
                      className="db-import-preview-name-input input"
                      value={displayName}
                      placeholder={t("database.import.namePlaceholder")}
                      disabled={importing}
                      onChange={(value) => updateCustomName(item.id, value)}
                    />,
                    "db-import-preview-name",
                  )}
                  {renderBodyCell(
                    "engine",
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
                    </span>,
                  )}
                  {renderBodyCell("host", hostText)}
                  {renderBodyCell("user", item.raw.user || "—")}
                  {renderBodyCell("database", item.raw.database || "—")}
                  {renderBodyCell(
                    "status",
                    issues.length === 0 ? (
                      <span className="db-import-preview-status db-import-preview-status--ready">
                        {t("database.import.statusReady")}
                      </span>
                    ) : (
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
                    ),
                    "db-import-preview-cell--status",
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </FormDialog>
  );
}
