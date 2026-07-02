import { Parser } from "node-sql-parser";
import { parserDatabaseOption } from "./dialect";
import { safeParseStatement } from "./ast";

const parser = new Parser();

export interface DerivedColumn {
  name: string;
  expression: string;
  sourceAlias: string;
}

type SelectAst = {
  type?: string;
  columns?: ColumnAst[];
  from?: FromItemAst | FromItemAst[];
  with?: WithItemAst[];
};

type ColumnAst = {
  expr?: unknown;
  as?: string | null;
};

type FromItemAst = {
  expr?: { ast?: SelectAst; parentheses?: boolean };
  as?: string | null;
  table?: string | null;
};

type WithItemAst = {
  name?: { value?: string };
  stmt?: { ast?: SelectAst };
};

function stripIdentifierQuotes(name: string): string {
  return name.replace(/^[`"]|[`"]$/g, "");
}

function columnOutputName(column: ColumnAst): string | null {
  if (column.as) {
    return stripIdentifierQuotes(String(column.as));
  }
  const expr = column.expr as { type?: string; column?: string | { expr?: { value?: string } } } | undefined;
  if (expr?.type === "column_ref" && expr.column) {
    if (typeof expr.column === "string") {
      return stripIdentifierQuotes(expr.column);
    }
    const nested = expr.column.expr?.value;
    if (nested) {
      return stripIdentifierQuotes(String(nested));
    }
  }
  return null;
}

function columnExpression(column: ColumnAst, dbType?: string | null): string {
  if (!column.expr) return "";
  try {
    return parser.exprToSQL(column.expr, parserDatabaseOption(dbType)).trim();
  } catch {
    return "";
  }
}

function indexSelectOutputs(
  select: SelectAst,
  alias: string,
  target: Map<string, Map<string, DerivedColumn>>,
  dbType?: string | null,
): void {
  if (!Array.isArray(select.columns)) return;

  const colMap = new Map<string, DerivedColumn>();
  for (const column of select.columns) {
    const name = columnOutputName(column);
    if (!name) continue;
    const expression = columnExpression(column, dbType);
    colMap.set(name.toLowerCase(), {
      name,
      expression: expression || name,
      sourceAlias: alias,
    });
  }
  if (colMap.size > 0) {
    target.set(alias.toLowerCase(), colMap);
  }
}

function walkFromList(
  from: FromItemAst | FromItemAst[] | undefined,
  target: Map<string, Map<string, DerivedColumn>>,
  dbType?: string | null,
): void {
  if (!from) return;
  const items = Array.isArray(from) ? from : [from];
  for (const item of items) {
    if (!item) continue;
    const subSelect = item.expr?.ast;
    const aliasRaw = item.as ? stripIdentifierQuotes(String(item.as)) : null;
    if (subSelect?.type === "select" && aliasRaw) {
      indexSelectOutputs(subSelect, aliasRaw, target, dbType);
      walkFromList(subSelect.from, target, dbType);
    }
  }
}

function walkWithClause(
  withItems: WithItemAst[] | null | undefined,
  target: Map<string, Map<string, DerivedColumn>>,
  dbType?: string | null,
): void {
  if (!withItems) return;
  for (const item of withItems) {
    const alias = item.name?.value ? stripIdentifierQuotes(String(item.name.value)) : null;
    const subSelect = item.stmt?.ast;
    if (!alias || subSelect?.type !== "select") continue;
    indexSelectOutputs(subSelect, alias, target, dbType);
    walkFromList(subSelect.from, target, dbType);
  }
}

/** 从语句 AST 收集子查询 / CTE 别名的输出列定义。 */
export function collectDerivedColumns(sql: string, dbType?: string | null): Map<string, Map<string, DerivedColumn>> {
  const result = new Map<string, Map<string, DerivedColumn>>();
  const ast = safeParseStatement(sql, dbType);
  if (!ast || typeof ast !== "object") return result;

  const root = (Array.isArray(ast) ? ast[0] : ast) as SelectAst;
  if (root.type !== "select") return result;

  walkWithClause(root.with ?? null, result, dbType);
  walkFromList(root.from, result, dbType);
  return result;
}

/** 解析 `alias.column` 对应的子查询派生列定义。 */
export function resolveDerivedColumnInStatement(
  sql: string,
  tableAlias: string,
  columnName: string,
  dbType?: string | null,
): DerivedColumn | null {
  const derived = collectDerivedColumns(sql, dbType);
  return derived.get(tableAlias.toLowerCase())?.get(columnName.toLowerCase()) ?? null;
}
