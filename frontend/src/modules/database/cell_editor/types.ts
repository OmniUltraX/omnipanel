export type CellEditorKind = "text" | "number" | "boolean" | "date" | "datetime" | "time" | "json" | "binary";

/** 短字符串列 varchar/char 等待 inline 编辑的最大声明长度 */
export const INLINE_TEXT_MAX_LENGTH = 256;

export function parseColumnCharLength(rawType: string): number | null {
  const match = rawType.toLowerCase().match(/\(\s*(\d+)\s*\)/);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

/** 是否为适合单元格内联编辑的短字符串列（排除 text/json/binary 等长内容类型） */
export function isShortTextColumn(rawType: string): boolean {
  const lower = rawType.toLowerCase();
  const kind = detectCellEditorKind(rawType);
  if (kind !== "text") return false;
  if (
    lower.includes("text") ||
    lower.includes("clob") ||
    lower.includes("json") ||
    lower.includes("blob") ||
    lower.includes("binary")
  ) {
    return false;
  }
  const length = parseColumnCharLength(rawType);
  if (length != null) {
    return length <= INLINE_TEXT_MAX_LENGTH;
  }
  if (lower.includes("enum") || lower.includes("set")) {
    return true;
  }
  return (
    lower.startsWith("varchar") ||
    lower.startsWith("char") ||
    lower.includes("character varying") ||
    lower.includes("nvarchar") ||
    lower.includes("nchar")
  );
}

/** 是否应在表格单元格内直接编辑（不走表单弹窗） */
export function shouldUseInlineCellEdit(rawType: string): boolean {
  const kind = detectCellEditorKind(rawType);
  if (kind === "number") return true;
  return isShortTextColumn(rawType);
}

export type CellDoubleClickEditStrategy = "inline" | "preview" | "panel";

/**
 * 双击单元格时的编辑策略：
 * - inline：单元格浮层编辑器（短字段 / 文本弹窗）
 * - preview：预览子窗（图片 / 音频等只读媒体）
 * - panel：展开右侧/底部值编辑器
 */
export function resolveCellDoubleClickEditStrategy(
  rawType: string,
  value: unknown,
): CellDoubleClickEditStrategy {
  const kind = detectCellEditorKind(rawType);
  if (kind === "binary") {
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (record.__omni === "blob") {
        const blobKind = record.kind;
        if (blobKind === "image" || blobKind === "audio") {
          return "preview";
        }
      }
    }
    return "panel";
  }
  if (
    kind === "boolean" ||
    kind === "number" ||
    kind === "date" ||
    kind === "datetime" ||
    kind === "time"
  ) {
    return "inline";
  }
  if (kind === "json") {
    return "inline";
  }
  if (kind === "text") {
    return "inline";
  }
  return "panel";
}

/** 内联编辑器初始文本（日期类规范化为原生 input 值） */
export function formatInlineEditText(kind: CellEditorKind, value: unknown): string {
  const raw = formatCellValue(value);
  switch (kind) {
    case "date":
      return normalizeDate(raw);
    case "datetime":
      return normalizeDatetime(raw);
    case "time":
      return normalizeTime(raw);
    default:
      return raw;
  }
}

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
  if (typeof value === "object") {
    // 避免把内联 base64 整段塞进二进制编辑器
    const record = value as Record<string, unknown>;
    if (record.__omni === "blob") {
      const size = typeof record.size === "number" ? record.size : 0;
      const kind = typeof record.kind === "string" ? record.kind : "binary";
      const mime = typeof record.mime === "string" ? record.mime : "";
      return `[BLOB · ${mime || kind} · ${size} bytes]`;
    }
    return JSON.stringify(value);
  }
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
  if (kind === "json") {
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  if (kind === "datetime") {
    // datetime-local → DB 常用空格格式
    return formatDatetimeDisplay(raw);
  }
  if (kind === "date") {
    return normalizeDate(raw);
  }
  if (kind === "time") {
    return formatTimeDisplay(raw);
  }
  return raw;
}

function coerceBooleanValue(value: unknown): boolean | undefined {
  if (value === true || value === false) return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return undefined;
}

/** 判断单元格编辑后的值是否与原始值等价（避免误标脏） */
export function isSameCellValue(originalValue: unknown, value: unknown): boolean {
  if (originalValue === value) return true;
  if (originalValue == null && value === "") return true;
  if (originalValue === "" && value == null) return true;

  const originalBool = coerceBooleanValue(originalValue);
  const nextBool = coerceBooleanValue(value);
  if (originalBool !== undefined && nextBool !== undefined) {
    return originalBool === nextBool;
  }

  if (typeof originalValue === "number" && typeof value === "string") {
    return String(originalValue) === value || String(originalValue) === value.trim();
  }
  if (typeof originalValue === "string" && typeof value === "number") {
    return originalValue === String(value) || originalValue.trim() === String(value);
  }
  if (typeof originalValue === "string" && typeof value === "string") {
    if (originalValue === value) return true;
    const originalNumber = Number(originalValue);
    const nextNumber = Number(value);
    if (Number.isFinite(originalNumber) && Number.isFinite(nextNumber)) {
      return originalNumber === nextNumber;
    }
  }

  return false;
}

/** Normalize a raw DB date value to YYYY-MM-DD for <input type="date"> */
export function normalizeDate(raw: string): string {
  const m = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : raw.slice(0, 10);
}

/** Normalize a raw DB datetime value to YYYY-MM-DDTHH:MM[:SS] for <input type="datetime-local"> */
export function normalizeDatetime(raw: string): string {
  const m = raw.match(
    /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/,
  );
  if (m) {
    return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}`;
  }
  const d = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  return d ? `${d[1]}-${d[2]}-${d[3]}T00:00:00` : raw;
}

/** 网格/文本编辑显示：YYYY-MM-DD HH:MM:SS */
export function formatDatetimeDisplay(raw: string): string {
  const m = raw.match(
    /(\d{4})[-/](\d{2})[-/](\d{2})[T\s]+(\d{2}):(\d{2})(?::(\d{2}))?/,
  );
  if (m) {
    return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] ?? "00"}`;
  }
  const d = raw.match(/(\d{4})[-/](\d{2})[-/](\d{2})/);
  return d ? `${d[1]}-${d[2]}-${d[3]} 00:00:00` : raw;
}

/** Normalize a raw DB time value to HH:MM[:SS] for <input type="time"> */
export function normalizeTime(raw: string): string {
  const m = raw.match(/(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return raw.slice(0, 8);
  return m[3] ? `${m[1]}:${m[2]}:${m[3]}` : `${m[1]}:${m[2]}`;
}

/** 网格/文本编辑显示：HH:MM:SS（有秒则保留） */
export function formatTimeDisplay(raw: string): string {
  const m = raw.match(/(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return raw;
  return `${m[1]}:${m[2]}:${m[3] ?? "00"}`;
}
