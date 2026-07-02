import { useCallback, useEffect, useMemo, useState } from "react";
import { FormDialog } from "../../components/ui/FormDialog";
import { Select } from "../../components/ui/Select";
import { useI18n } from "../../i18n";
import { useSettingsStore } from "../../stores/settingsStore";
import type { DbConnectionGroup } from "../../stores/dbGroupStore";
import { getEngineIconByType } from "./engineIcons";
import { previewItemToConnection } from "./navicatImport/buildImportPreview";
import type { NavicatImportIssue, NavicatImportPreviewItem } from "./navicatImport/types";
import { saveConnection } from "./api";

interface ConnectionImportPreviewDialogProps {
  open: boolean;
  fileName: string;
  items: NavicatImportPreviewItem[];
  groups: DbConnectionGroup[];
  defaultGroup?: string;
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

export function ConnectionImportPreviewDialog({
  open,
  fileName,
  items,
  groups,
  defaultGroup = "默认",
  onClose,
  onImported,
}: ConnectionImportPreviewDialogProps) {
  const { t } = useI18n();
  const resolvedTheme = useSettingsStore((s) => s.resolved);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [targetGroup, setTargetGroup] = useState(defaultGroup);
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState<{ kind: "info" | "success" | "error"; message: string } | null>(
    null,
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    setSelectedIds(
      new Set(items.filter((item) => item.importable).map((item) => item.id)),
    );
    setTargetGroup(defaultGroup);
    setImporting(false);
    setStatus(null);
  }, [open, items, defaultGroup]);

  const importableItems = useMemo(() => items.filter((item) => item.importable), [items]);
  const selectedCount = useMemo(
    () => importableItems.filter((item) => selectedIds.has(item.id)).length,
    [importableItems, selectedIds],
  );

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
        await saveConnection(previewItemToConnection(item, targetGroup));
        success += 1;
      } catch {
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
  }, [importableItems, onClose, onImported, selectedIds, t, targetGroup]);

  const groupOptions = useMemo(() => {
    const names = groups.map((group) => group.name);
    if (!names.includes(targetGroup)) {
      return [targetGroup, ...names];
    }
    return names.length > 0 ? names : [targetGroup];
  }, [groups, targetGroup]);

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
        <label className="db-import-preview-group">
          <span>{t("database.import.targetGroup")}</span>
          <Select
            value={targetGroup}
            onChange={setTargetGroup}
            options={groupOptions}
            disabled={importing}
          />
        </label>
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

      <div className="db-import-preview-table-wrap">
        <table className="db-import-preview-table">
          <thead>
            <tr>
              <th aria-label={t("database.import.columnSelect")} />
              <th>{t("database.import.columnName")}</th>
              <th>{t("database.import.columnEngine")}</th>
              <th>{t("database.import.columnHost")}</th>
              <th>{t("database.import.columnUser")}</th>
              <th>{t("database.import.columnDatabase")}</th>
              <th>{t("database.import.columnStatus")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const iconUrl = item.engine
                ? getEngineIconByType(item.engine, resolvedTheme)
                : null;
              return (
                <tr
                  key={item.id}
                  className={`db-import-preview-row${item.importable ? "" : " db-import-preview-row--disabled"}`}
                >
                  <td>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(item.id)}
                      disabled={!item.importable || importing}
                      onChange={(event) => toggleItem(item.id, event.target.checked)}
                    />
                  </td>
                  <td className="db-import-preview-name">{item.raw.name || "—"}</td>
                  <td>
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
                  </td>
                  <td>
                    {item.raw.host || "—"}
                    {item.raw.port ? `:${item.raw.port}` : ""}
                  </td>
                  <td>{item.raw.user || "—"}</td>
                  <td>{item.raw.database || "—"}</td>
                  <td>
                    {item.issues.length === 0 ? (
                      <span className="db-import-preview-status db-import-preview-status--ready">
                        {t("database.import.statusReady")}
                      </span>
                    ) : (
                      <div className="db-import-preview-issues">
                        {item.issues.map((issue) => (
                          <span
                            key={issue}
                            className="db-import-preview-status db-import-preview-status--warn"
                          >
                            {issueLabel(issue, t)}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </FormDialog>
  );
}
