/** SQL 编辑器右键菜单用的纯文本变换。不碰编辑器实例。 */

export function toggleLineComment(text: string): string {
  const lines = text.split("\n");
  const content = lines.filter((line) => line.trim().length > 0);
  const commented =
    content.length > 0 && content.every((line) => /^\s*--/.test(line));
  return lines
    .map((line) => {
      if (!line.trim()) return line;
      if (commented) return line.replace(/^(\s*)--\s?/, "$1");
      return line.replace(/^(\s*)/, "$1-- ");
    })
    .join("\n");
}

export function toggleBlockComment(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("/*") && trimmed.endsWith("*/")) {
    return text.replace(/^\s*\/\*\s?/, "").replace(/\s?\*\/\s*$/, "");
  }
  return `/* ${text} */`;
}

/** 折叠空白，保留引号和行注释。 */
export function compressSql(sql: string): string {
  let out = "";
  let quote: "'" | '"' | "`" | null = null;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i] ?? "";
    const next = sql[i + 1] ?? "";
    if (!quote && ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const chunk = sql.slice(i, end < 0 ? sql.length : end);
      out += chunk.trimEnd();
      i = end < 0 ? sql.length : end - 1;
      continue;
    }
    if (!quote && (ch === "'" || ch === '"' || ch === "`")) {
      quote = ch;
      out += ch;
      continue;
    }
    if (quote) {
      out += ch;
      if (ch === quote && sql[i - 1] !== "\\") quote = null;
      continue;
    }
    if (/\s/.test(ch)) {
      if (out && !/\s$/.test(out)) out += " ";
      continue;
    }
    out += ch;
  }
  return out.trim();
}

export function deleteEmptyLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .join("\n");
}

/** 把选中的标识符收成 `'a', 'b'` 列表。 */
export function toDelimitedList(text: string): string {
  const parts = text
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/^['"`]|['"`]$/g, "").replace(/'/g, "''"));
  return parts.map((part) => `'${part}'`).join(", ");
}

/**
 * 把语句里的 `SELECT *` / `SELECT alias.*` 换成列清单。
 * 找不到星号或没有列时返回 null。
 */
export function expandSelectStar(
  sql: string,
  columnNames: string[],
  quote: (name: string) => string,
): string | null {
  if (columnNames.length === 0) return null;
  const match = /\b(select\s+(?:distinct\s+)?)((?:[\w`"[\].]+\s*\.\s*)?)(\*)/i.exec(sql);
  if (!match || match.index == null) return null;
  const prefix = match[2] ?? "";
  const list = columnNames.map((name) => `${prefix}${quote(name)}`).join(", ");
  return sql.slice(0, match.index) + (match[1] ?? "") + list + sql.slice(match.index + match[0].length);
}

export function quoteSqlIdent(dbType: string | undefined, name: string): string {
  const kind = (dbType ?? "mysql").toLowerCase();
  if (kind.includes("postgres") || kind === "pg") {
    return `"${name.replace(/"/g, '""')}"`;
  }
  if (kind.includes("sqlserver") || kind.includes("mssql")) {
    return `[${name.replace(/]/g, "]]")}]`;
  }
  return `\`${name.replace(/`/g, "``")}\``;
}
