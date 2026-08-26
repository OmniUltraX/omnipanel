/** 生成克隆表结构 SQL（不含数据）。 */

import { catalogFamily, canonicalHostEngine, hostCapabilities } from "../hostCapabilities";

function mysqlQuoteId(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

function pgQuoteId(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function sqliteQuoteId(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

type CloneEngine = "mysql" | "postgres" | "sqlite" | "oracle" | "hive" | "generic" | "other";

function normalizeEngine(dbType: string): CloneEngine {
  const engine = canonicalHostEngine(dbType);
  if (engine === "mysql") return "mysql";
  if (engine === "postgres") return "postgres";
  if (engine === "sqlite") return "sqlite";
  const family = catalogFamily(engine);
  if (family === "mysqlLike") return "mysql";
  if (family === "postgresLike") return "postgres";
  if (family === "oracleLike") return "oracle";
  if (family === "hiveLike") return "hive";
  if (family === "genericSql") return "generic";
  return "other";
}

export function isCloneTableSqlSupported(dbType: string): boolean {
  return hostCapabilities(dbType).cloneTable;
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
    return `CREATE TABLE ${pgQuoteId(target)} (LIKE ${pgQuoteId(source)} INCLUDING ALL)`;
  }
  if (engine === "sqlite" || engine === "generic") {
    return `CREATE TABLE ${sqliteQuoteId(target)} AS SELECT * FROM ${sqliteQuoteId(source)} WHERE 0`;
  }
  if (engine === "oracle") {
    const schema = pgQuoteId(dbName.trim());
    return `CREATE TABLE ${schema}.${pgQuoteId(target)} AS SELECT * FROM ${schema}.${pgQuoteId(source)} WHERE 1=0`;
  }
  if (engine === "hive") {
    const db = mysqlQuoteId(dbName.trim());
    return `CREATE TABLE ${db}.${mysqlQuoteId(target)} AS SELECT * FROM ${db}.${mysqlQuoteId(source)} WHERE 1=0`;
  }
  return null;
}
