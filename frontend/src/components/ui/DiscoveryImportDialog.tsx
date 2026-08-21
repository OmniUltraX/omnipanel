import { useEffect, useMemo, useState } from "react";
import type { ImportCandidate } from "@omnipanel/plugin-sdk";
import { ImportPreview } from "@omnipanel/plugin-ui";
import { FormDialog } from "./form/FormDialog";
import { useI18n } from "../../i18n";

export type DiscoveryRowStatus = "importable" | "duplicate" | "unsupported";

export type DiscoveryPreviewRow = {
  id: string;
  candidate: ImportCandidate;
  label: string;
  kindLabel: string;
  host: string;
  status: DiscoveryRowStatus;
  disabled: boolean;
};

interface Props {
  open: boolean;
  title: string;
  hint?: string;
  rows: DiscoveryPreviewRow[];
  busy?: boolean;
  onClose: () => void;
  onImport: (selected: DiscoveryPreviewRow[]) => void;
}

export function DiscoveryImportDialog({
  open,
  title,
  hint,
  rows,
  busy = false,
  onClose,
  onImport,
}: Props) {
  const { t } = useI18n();
  const importableIds = useMemo(
    () => rows.filter((row) => row.status === "importable" && !row.disabled).map((row) => row.id),
    [rows],
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(importableIds));

  useEffect(() => {
    setSelectedIds(new Set(importableIds));
  }, [importableIds]);

  const statusLabel = (status: DiscoveryRowStatus) => {
    if (status === "duplicate") return t("plugins.discovery.statusDuplicate");
    if (status === "unsupported") return t("plugins.discovery.statusUnsupported");
    return t("plugins.discovery.statusImportable");
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={title}
      primaryAction={{
        label: t("plugins.discovery.import"),
        disabled: busy || selectedIds.size === 0,
        onClick: () => {
          onImport(rows.filter((row) => selectedIds.has(row.id) && !row.disabled));
        },
      }}
    >
      {hint ? <p className="setting-hint">{hint}</p> : null}
      <ImportPreview
        items={rows}
        selectedIds={selectedIds}
        onToggle={(id, next) => {
          setSelectedIds((prev) => {
            const copy = new Set(prev);
            if (next) copy.add(id);
            else copy.delete(id);
            return copy;
          });
        }}
        columns={[
          { id: "name", header: t("plugins.discovery.colName"), render: (row) => row.label },
          { id: "kind", header: t("plugins.discovery.colKind"), render: (row) => row.kindLabel },
          { id: "host", header: t("plugins.discovery.colHost"), render: (row) => row.host },
          { id: "status", header: t("plugins.discovery.colStatus"), render: (row) => statusLabel(row.status) },
        ]}
      />
    </FormDialog>
  );
}
