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
}

/** 将表格数据序列化为 CSV 字符串。columns 是列名，rows 每行是按列名索引的对象。 */
export function toCsv(
  columns: string[],
  rows: ReadonlyArray<Record<string, unknown>>,
  options: ToCsvOptions = {},
): string {
  const { bom = true, header, newline = "\r\n" } = options;
  const headerLine = (header ?? columns).map(escapeCsvCell).join(",");
  const dataLines = rows.map((row) =>
    columns.map((col) => escapeCsvCell(row?.[col])).join(","),
  );
  const text = [headerLine, ...dataLines].join(newline) + newline;
  return bom ? "\uFEFF" + text : text;
}
