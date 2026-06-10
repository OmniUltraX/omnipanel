export type CellEditorKind = "text" | "number" | "boolean" | "date" | "datetime" | "time" | "json" | "binary";

/**
 * Map a raw database column type string to a CellEditorKind.
 * Examples: "int" → "number", "varchar(255)" → "text", "timestamp" → "datetime", "date" → "date", "time" → "time", "json" → "json"
 */
export function detectCellEditorKind(rawType: string): CellEditorKind {
  const t = rawType.toLowerCase().replace(/\(.*\)/, "").trim();
  if (
    t.includes("int") ||
    t.includes("float") ||
    t.includes("double") ||
    t.includes("decimal") ||
    t.includes("numeric") ||
    t.includes("real") ||
    t.includes("number") ||
    t === "tinyint" ||
    t === "smallint" ||
    t === "mediumint" ||
    t === "bigint" ||
    t === "bit"
  ) {
    return "number";
  }
  if (t.includes("bool") || t === "boolean") {
    return "boolean";
  }
  if (t === "date") {
    return "date";
  }
  if (t === "time" || t === "timetz") {
    return "time";
  }
  if (
    t.includes("timestamp") ||
    t.includes("datetime") ||
    t === "year"
  ) {
    return "datetime";
  }
  if (t.includes("json")) {
    return "json";
  }
  if (
    t.includes("blob") ||
    t.includes("binary") ||
    t.includes("bytea") ||
    t === "raw"
  ) {
    return "binary";
  }
  return "text";
}

/** Format a raw cell value for display in the editor */
export function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Parse editor string back to the appropriate JS value for SQL */
export function parseCellValue(kind: CellEditorKind, raw: string): unknown {
  if (kind === "number") {
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    // 整数原样保留为字符串，避免 >2^53 的 BIGINT 经 JS Number 往返丢精度；
    // 后端 SQL 拼接时会按字符串转义，原值不损失。带小数点/科学计数法才转 number。
    if (/^-?\d+$/.test(trimmed)) {
      return trimmed;
    }
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : trimmed;
  }
  if (kind === "boolean") {
    return raw === "true" || raw === "1";
  }
  return raw;
}

/** Normalize a raw DB date value to YYYY-MM-DD for <input type="date"> */
export function normalizeDate(raw: string): string {
  const m = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : raw.slice(0, 10);
}

/** Normalize a raw DB datetime value to YYYY-MM-DDTHH:MM for <input type="datetime-local"> */
export function normalizeDatetime(raw: string): string {
  const m = raw.match(
    /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/,
  );
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
  // date-only fallback
  const d = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  return d ? `${d[1]}-${d[2]}-${d[3]}T00:00` : raw;
}

/** Normalize a raw DB time value to HH:MM for <input type="time"> */
export function normalizeTime(raw: string): string {
  const m = raw.match(/(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : raw.slice(0, 5);
}
