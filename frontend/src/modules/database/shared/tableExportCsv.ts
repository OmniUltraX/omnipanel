import { matrixToDelimited } from "./delimitedText";
import { toCsv, type ToCsvOptions } from "./csvExport";

export interface TableExportOptions {
  /** 转置：列变行 */
  transpose?: boolean;
  /** 添加列标题（表头） */
  includeColumnHeaders?: boolean;
  /** 添加行标题（行号；转置时为原列名） */
  includeRowHeaders?: boolean;
  /** UTF-8 BOM，默认 true */
  bom?: boolean;
  newline?: string;
}

/** 将表数据按导出选项生成 CSV 文本。 */
export function buildTableExportCsv(
  columns: string[],
  rows: ReadonlyArray<Record<string, unknown>>,
  options: TableExportOptions = {},
): string {
  const {
    transpose = false,
    includeColumnHeaders = true,
    includeRowHeaders = false,
    bom = true,
    newline = "\r\n",
  } = options;

  if (!transpose && !includeRowHeaders) {
    return toCsv(columns, rows, {
      bom,
      newline,
      includeHeader: includeColumnHeaders,
    } satisfies ToCsvOptions);
  }

  let matrix: unknown[][];

  if (!transpose) {
    matrix = rows.map((row) => columns.map((col) => row?.[col] ?? null));
    if (includeRowHeaders) {
      matrix = matrix.map((row, index) => [index + 1, ...row]);
    }
    if (includeColumnHeaders) {
      const header = includeRowHeaders ? ["", ...columns] : [...columns];
      matrix = [header, ...matrix];
    }
  } else {
    matrix = columns.map((col) => rows.map((row) => row?.[col] ?? null));
    if (includeRowHeaders) {
      matrix = matrix.map((row, index) => [columns[index], ...row]);
    }
    if (includeColumnHeaders) {
      const indices = rows.map((_, index) => index + 1);
      const header = includeRowHeaders ? ["", ...indices] : indices;
      matrix = [header, ...matrix];
    }
  }

  return matrixToDelimited(matrix, "csv", { bom, newline });
}

/** 取导出预览文本的前 N 行（含换行）。 */
export function takeExportPreviewLines(text: string, maxLines = 10): string {
  if (!text) return "";
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.slice(0, maxLines).join("\n");
}
