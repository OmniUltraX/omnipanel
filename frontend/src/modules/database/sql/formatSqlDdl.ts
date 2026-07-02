function resolveDialect(dbType: string): "mysql" | "generic" {
  const normalized = dbType.trim().toLowerCase();
  if (normalized.includes("mysql") || normalized === "mariadb") {
    return "mysql";
  }
  return "generic";
}

function isQuoted(ch: string): boolean {
  return ch === "`" || ch === "'" || ch === '"';
}

/** 在括号深度为 1 时于逗号后换行（忽略引号内逗号）。 */
function breakCreateTableColumns(sql: string): string {
  let depth = 0;
  let quote: string | null = null;
  let out = "";

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];

    if (quote) {
      out += ch;
      if (ch === quote && sql[i - 1] !== "\\") {
        quote = null;
      }
      continue;
    }

    if (isQuoted(ch)) {
      quote = ch;
      out += ch;
      continue;
    }

    if (ch === "(") {
      depth += 1;
      out += ch;
      if (depth === 1) {
        out += "\n  ";
      }
      continue;
    }

    if (ch === ")") {
      depth -= 1;
      out += ch;
      continue;
    }

    if (ch === "," && depth === 1) {
      out += ",\n  ";
      continue;
    }

    if (/\s/.test(ch) && depth === 0) {
      if (!out.endsWith(" ") && !out.endsWith("\n")) {
        out += " ";
      }
      continue;
    }

    out += ch;
  }

  return out.trim();
}

function breakTableOptions(sql: string): string {
  return sql
    .replace(/\)\s*(ENGINE|DEFAULT|AUTO_INCREMENT|COMMENT|ROW_FORMAT|KEY_BLOCK_SIZE|CHARSET|COLLATE|PARTITION)/gi, ")\n$1")
    .replace(/\s+(ENGINE|DEFAULT CHARSET|COLLATE|COMMENT|AUTO_INCREMENT|ROW_FORMAT)=/gi, "\n  $1=")
    .replace(/\s+(UNION|PARTITION BY)\s+/gi, "\n$1 ");
}

/** 格式化建表 DDL；失败时返回原始文本。 */
export function formatSqlDdl(ddl: string, dbType: string): string {
  const trimmed = ddl.trim().replace(/\r\n/g, "\n");
  if (!trimmed) {
    return "";
  }

  if (trimmed.split("\n").length > 4) {
    return trimmed;
  }

  const compact = trimmed.replace(/\s+/g, " ");
  const dialect = resolveDialect(dbType);

  if (dialect === "mysql" && /^create\s+table/i.test(compact)) {
    let formatted = breakCreateTableColumns(compact);
    formatted = breakTableOptions(formatted);
    return formatted;
  }

  return compact
    .replace(/\s*,\s*/g, ",\n  ")
    .replace(/\(\s*/g, "(\n  ")
    .replace(/\)\s*/g, "\n)\n");
}
