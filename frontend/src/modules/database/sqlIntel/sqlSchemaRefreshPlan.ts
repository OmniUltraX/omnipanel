import {
  classifySqlHistoryKind,
  sqlHistoryKindTone,
} from "../sql/classifySqlHistoryKind";
import { splitSqlStatements } from "./sqlLex";

export type SqlSchemaRefreshPlan =
  | { level: "connection"; connId: string }
  | { level: "database"; connId: string; dbName: string };

function stripLeadingComments(sql: string): string {
  let rest = sql.trimStart();
  for (;;) {
    if (rest.startsWith("--")) {
      const lineEnd = rest.indexOf("\n");
      rest = lineEnd >= 0 ? rest.slice(lineEnd + 1).trimStart() : "";
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/");
      rest = end >= 0 ? rest.slice(end + 2).trimStart() : "";
      continue;
    }
    break;
  }
  return rest;
}

function isSchemaMutatingStatement(sql: string): boolean {
  const kind = classifySqlHistoryKind(sql);
  return sqlHistoryKindTone(kind) === "schema";
}

function planOneStatement(
  sql: string,
  connId: string,
  activeDatabase: string,
): SqlSchemaRefreshPlan | null {
  const trimmed = sql.trim();
  if (!trimmed || !isSchemaMutatingStatement(trimmed)) {
    return null;
  }

  const head = stripLeadingComments(trimmed);

  if (/^(CREATE|DROP|ALTER)\s+(DATABASE|SCHEMA)\b/i.test(head)) {
    return { level: "connection", connId };
  }

  const qualifiedObject =
    /^(?:CREATE|DROP|ALTER|RENAME|COMMENT\s+ON)\b[\s\S]*?\b(?:TABLE|VIEW|INDEX|TRIGGER|PROCEDURE|FUNCTION|EVENT|SEQUENCE)\s+(?:IF\s+NOT\s+EXISTS\s+|IF\s+EXISTS\s+)?(?:(`([^`]+)`|"([^"]+)"|'([^']+)'|([A-Za-z0-9_$]+))\s*\.\s*)?/i.exec(
      head,
    );
  const dbFromSql = qualifiedObject?.[2] ?? qualifiedObject?.[3] ?? qualifiedObject?.[4] ?? qualifiedObject?.[5];
  if (dbFromSql) {
    return { level: "database", connId, dbName: dbFromSql };
  }

  const active = activeDatabase.trim();
  if (active) {
    return { level: "database", connId, dbName: active };
  }

  return { level: "connection", connId };
}

/** 合并多语句执行后的 Schema 刷新计划（连接级优先于库级）。 */
export function collectSqlSchemaRefreshPlans(
  sql: string,
  connId: string,
  activeDatabase: string,
): SqlSchemaRefreshPlan[] {
  const trimmed = sql.trim();
  if (!trimmed) {
    return [];
  }

  const parts = splitSqlStatements(trimmed);
  const statements =
    parts.length > 0 ? parts.map((part) => part.sql.trim()).filter(Boolean) : [trimmed];

  let connectionLevel = false;
  const databaseNames = new Set<string>();

  for (const statement of statements) {
    const plan = planOneStatement(statement, connId, activeDatabase);
    if (!plan) {
      continue;
    }
    if (plan.level === "connection") {
      connectionLevel = true;
    } else {
      databaseNames.add(plan.dbName);
    }
  }

  if (connectionLevel) {
    return [{ level: "connection", connId }];
  }

  return [...databaseNames].map((dbName) => ({
    level: "database" as const,
    connId,
    dbName,
  }));
}
