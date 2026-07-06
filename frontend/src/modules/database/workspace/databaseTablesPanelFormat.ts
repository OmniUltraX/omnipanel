import { formatBytes } from "../../../stores/sshStatsStore";
import type { DbTableDetails } from "../api";

export function displayDetailValue(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "—";
}

export function formatTableRowCount(value: number | null | undefined): string {
  if (value == null || value < 0) {
    return "—";
  }
  return value.toLocaleString();
}

export function formatTableDataSummary(
  rowCount: number | null | undefined,
  dataLength: number | null | undefined,
): string {
  const rows = formatTableRowCount(rowCount);
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
