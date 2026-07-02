import { useMemo } from "react";
import { useI18n } from "../../../i18n";
import { formatBytes } from "../../../stores/sshStatsStore";
import type { DbTableDetails } from "../api";

function displayValue(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "—";
}

function formatRowCount(value: number | null | undefined): string {
  if (value == null || value < 0) {
    return "—";
  }
  return value.toLocaleString();
}

function formatDataSummary(
  rowCount: number | null | undefined,
  dataLength: number | null | undefined,
): string {
  const rows = formatRowCount(rowCount);
  const size =
    dataLength != null && dataLength >= 0 ? formatBytes(dataLength) : "—";
  if (rows === "—" && size === "—") {
    return "—";
  }
  if (rows === "—") {
    return size;
  }
  if (size === "—") {
    return rows;
  }
  return `${rows} · ${size}`;
}

export interface TableDetailsSummaryProps {
  details: DbTableDetails | null;
  loading: boolean;
  error: string | null;
  fallbackComment?: string;
}

export function TableDetailsSummary({
  details,
  loading,
  error,
  fallbackComment,
}: TableDetailsSummaryProps) {
  const { t } = useI18n();

  const rows = useMemo(
    () =>
      [
        {
          label: t("database.tablesPanel.details.data"),
          value: details
            ? formatDataSummary(details.rowCount ?? null, details.dataLength ?? null)
            : "—",
        },
        {
          label: t("database.tablesPanel.details.rowFormat"),
          value: displayValue(details?.rowFormat ?? null),
        },
        {
          label: t("database.tablesPanel.details.engine"),
          value: displayValue(details?.engine ?? null),
        },
        {
          label: t("database.tablesPanel.details.createTime"),
          value: displayValue(details?.createTime ?? null),
        },
        {
          label: t("database.tablesPanel.details.updateTime"),
          value: displayValue(details?.updateTime ?? null),
        },
        {
          label: t("database.tablesPanel.details.comment"),
          value: displayValue(details?.comment ?? fallbackComment ?? null),
        },
        {
          label: t("database.tablesPanel.details.collation"),
          value: displayValue(details?.collation ?? null),
        },
      ] as const,
    [details, fallbackComment, t],
  );

  if (loading) {
    return (
      <div className="db-table-details db-table-details--loading">
        {t("database.tablesPanel.detailsLoading")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="db-table-details db-table-details--error">
        {t("database.tablesPanel.detailsFailed", { message: error })}
      </div>
    );
  }

  if (!details) {
    return null;
  }

  return (
    <dl className="db-table-details">
      {rows.map((row) => (
        <div key={row.label} className="db-table-details-row">
          <dt>{row.label}</dt>
          <dd title={row.value}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
