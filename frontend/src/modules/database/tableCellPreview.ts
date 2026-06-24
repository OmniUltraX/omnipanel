export type CellPreviewContent =
  | { kind: "json"; value: object }
  | { kind: "text"; text: string };

export function isJsonColumnType(columnType?: string): boolean {
  if (!columnType) return false;
  const lower = columnType.toLowerCase();
  return lower === "json" || lower === "jsonb" || lower.includes("json");
}

export function cellValueToDisplayText(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

/** 解析单元格预览内容：JSON 对象/数组用 JsonView，其余用纯文本。 */
export function resolveCellPreviewContent(
  value: unknown,
  columnType?: string,
): CellPreviewContent {
  if (value === null || value === undefined) {
    return { kind: "text", text: "NULL" };
  }

  if (typeof value === "object") {
    return { kind: "json", value: value as object };
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    const tryJson = isJsonColumnType(columnType)
      || trimmed.startsWith("{")
      || trimmed.startsWith("[");
    if (tryJson && trimmed.length > 0) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed !== null && typeof parsed === "object") {
          return { kind: "json", value: parsed as object };
        }
      } catch {
        // 非合法 JSON 字符串，按文本展示
      }
    }
    return { kind: "text", text: value };
  }

  return { kind: "text", text: String(value) };
}
