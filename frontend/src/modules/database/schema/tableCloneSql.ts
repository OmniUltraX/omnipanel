/** 生成克隆表结构 SQL（不含数据）。 */

function mysqlQuoteId(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

function pgQuoteId(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function sqliteQuoteId(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function normalizeEngine(dbType: string): "mysql" | "postgres" | "sqlite" | "other" {
  const engine = dbType.toLowerCase();
  if (engine === "mysql" || engine === "mariadb") return "mysql";
  if (engine === "postgresql" || engine === "postgres") return "postgres";
  if (engine === "sqlite" || engine === "sqlite3") return "sqlite";
  return "other";
}

export function isCloneTableSqlSupported(dbType: string): boolean {
  return normalizeEngine(dbType) !== "other";
}

/** 在已有表名集合中分配不冲突的克隆名：foo_copy / foo_copy_2 … */
export function allocateCloneTableName(sourceName: string, existingNames: Iterable<string>): string {
  const existing = new Set(
    [...existingNames].map((name) => name.toLowerCase()),
  );
  const base = `${sourceName}_copy`;
  if (!existing.has(base.toLowerCase())) {
    return base;
  }
  for (let i = 2; i < 10_000; i += 1) {
    const candidate = `${base}_${i}`;
    if (!existing.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return `${base}_${Date.now()}`;
}

export function buildCloneTableSql(
  dbType: string,
  dbName: string,
  sourceTable: string,
  targetTable: string,
): string | null {
  const engine = normalizeEngine(dbType);
  const source = sourceTable.trim();
  const target = targetTable.trim();
  if (!source || !target) return null;

  if (engine === "mysql") {
    const db = mysqlQuoteId(dbName.trim());
    return `CREATE TABLE ${db}.${mysqlQuoteId(target)} LIKE ${db}.${mysqlQuoteId(source)}`;
  }
  if (engine === "postgres") {
    // public schema；LIKE … INCLUDING ALL 复制约束/索引定义（仍无数据）
    return `CREATE TABLE ${pgQuoteId(target)} (LIKE ${pgQuoteId(source)} INCLUDING ALL)`;
  }
  if (engine === "sqlite") {
    // 仅结构：LIMIT 0 不拷贝行
    return `CREATE TABLE ${sqliteQuoteId(target)} AS SELECT * FROM ${sqliteQuoteId(source)} WHERE 0`;
  }
  return null;
}
