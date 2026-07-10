import { matrixToDelimited, parseDelimitedMatrix, type DelimitedTextFormat } from "./delimitedText";

export type { DelimitedTextFormat } from "./delimitedText";
export { delimitedSeparator, matrixToDelimited, parseDelimitedMatrix } from "./delimitedText";

function escapeCsvCell(value: unknown): string {
  if (value == null) return "";
  let str: string;
  if (value instanceof Date) {
    str = value.toISOString();
  } else if (typeof value === "object") {
    str = JSON.stringify(value);
  } else {
    str = String(value);
  }
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
export interface ToCsvOptions {
  /** 是否在首行加 BOM（UTF-8 BOM 帮助 Excel 识别中文） */
  bom?: boolean;
  /** 列头覆盖；缺省时直接使用 columns 本身 */
  header?: string[];
  /** 行分隔符，默认 "\r\n" */
  newline?: string;
  /** 是否输出表头行，默认 true */
  includeHeader?: boolean;
}

/** 将表格数据序列化为 CSV 字符串。columns 是列名，rows 每行是按列名索引的对象。 */
export function toCsv(
  columns: string[],
  rows: ReadonlyArray<Record<string, unknown>>,
  options: ToCsvOptions = {},
): string {
  const { bom = true, header, newline = "\r\n", includeHeader = true } = options;
  const headerLine = (header ?? columns).map(escapeCsvCell).join(",");
  const dataLines = rows.map((row) =>
    columns.map((col) => escapeCsvCell(row?.[col])).join(","),
  );
  const lines = includeHeader ? [headerLine, ...dataLines] : dataLines;
  const text = lines.join(newline) + (lines.length > 0 ? newline : "");
  return bom ? "\uFEFF" + text : text;
}

/** 将二维数组序列化为 CSV（无表头，适合剪贴板选区复制）。 */
export function matrixToCsv(
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  options: Pick<ToCsvOptions, "bom" | "newline"> = {},
): string {
  return matrixToDelimited(rows, "csv", options);
}

/** 解析 CSV 文本为二维字符串矩阵（支持引号与转义）。 */
export function parseCsvMatrix(text: string): string[][] {
  return parseDelimitedMatrix(text, "csv");
}

/** 解析 TSV 文本为二维字符串矩阵。 */
export function parseTsvMatrix(text: string): string[][] {
  return parseDelimitedMatrix(text, "tsv");
}

/** 按格式解析剪贴板分隔文本。 */
export function parseClipboardMatrix(text: string, format: DelimitedTextFormat): string[][] {
  return parseDelimitedMatrix(text, format);
}