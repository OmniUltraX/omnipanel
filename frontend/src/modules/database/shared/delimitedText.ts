export type DelimitedTextFormat = "csv" | "tsv";

export function delimitedSeparator(format: DelimitedTextFormat): string {
  return format === "tsv" ? "\t" : ",";
}

function escapeDelimitedCell(value: unknown, delimiter: string): string {
  if (value == null) return "";
  let str: string;
  if (value instanceof Date) {
    str = value.toISOString();
  } else if (typeof value === "object") {
    str = JSON.stringify(value);
  } else {
    str = String(value);
  }
  if (/["\r\n]/.test(str) || str.includes(delimiter)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export interface DelimitedTextOptions {
  bom?: boolean;
  newline?: string;
}

/** 将二维数组序列化为分隔文本（无表头，适合剪贴板选区复制）。 */
export function matrixToDelimited(
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  format: DelimitedTextFormat,
  options: DelimitedTextOptions = {},
): string {
  const { bom = false, newline = "\r\n" } = options;
  if (rows.length === 0) return "";
  const delimiter = delimitedSeparator(format);
  const text =
    rows.map((row) => row.map((cell) => escapeDelimitedCell(cell, delimiter)).join(delimiter)).join(newline) +
    newline;
  return bom ? "\uFEFF" + text : text;
}

/** 解析分隔文本为二维字符串矩阵（支持引号与转义）。 */
export function parseDelimitedMatrix(text: string, format: DelimitedTextFormat): string[][] {
  const delimiter = delimitedSeparator(format);
  const normalized = text.replace(/\uFEFF/g, "");
  if (!normalized.trim()) return [];

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (normalized[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\r") {
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      cell = "";
      if (row.length > 1 || row[0] !== "") {
        rows.push(row);
      }
      row = [];
      continue;
    }
    cell += ch;
  }

  row.push(cell);
  if (row.length > 1 || row[0] !== "") {
    rows.push(row);
  }
  return rows;
}
