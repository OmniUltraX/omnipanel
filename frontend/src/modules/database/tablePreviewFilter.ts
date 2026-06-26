import {
  formatQuery,
  prepareRuleGroup,
  type Field,
  type RuleGroupType,
  type RuleType,
} from "react-querybuilder";
import type { DbColumnMeta } from "./api";
import type { SortState } from "./dbWorkspaceState";
import { buildOrderByClause } from "./dbWorkspaceState";

const EMPTY_TABLE_FILTER_BASE: RuleGroupType = {
  combinator: "and",
  rules: [],
};

export const EMPTY_TABLE_FILTER: RuleGroupType = prepareRuleGroup(EMPTY_TABLE_FILTER_BASE);

/** 转置视图第一列表头：编辑全表过滤（不限单列） */
export const TABLE_FILTER_ALL_COLUMNS = "__all__";

/** 确保过滤 query 中每条 rule / group 都有唯一 id，供 QueryBuilder 列表渲染使用 */
export function ensureTableFilterQuery(filter: RuleGroupType | null | undefined): RuleGroupType {
  return prepareRuleGroup(filter ?? EMPTY_TABLE_FILTER_BASE);
}

export function isTableFilterActive(filter: RuleGroupType | null | undefined): boolean {
  return Boolean(filter?.rules?.length);
}

function isRuleGroup(rule: RuleType | RuleGroupType): rule is RuleGroupType {
  return "rules" in rule;
}

export function getFilterColumnNames(filter: RuleGroupType | null | undefined): Set<string> {
  const names = new Set<string>();
  if (!filter) return names;

  const walk = (group: RuleGroupType) => {
    for (const rule of group.rules) {
      if (isRuleGroup(rule)) {
        walk(rule);
      } else if (rule.field) {
        names.add(String(rule.field));
      }
    }
  };
  walk(filter);
  return names;
}

function sqlPresetForDbType(dbType: string): "mysql" | "postgresql" | "sqlite" | "ansi" {
  const normalized = dbType.toLowerCase();
  if (normalized === "mysql" || normalized === "mariadb") return "mysql";
  if (normalized === "postgres" || normalized === "postgresql" || normalized === "pg") {
    return "postgresql";
  }
  if (normalized === "sqlite" || normalized === "sqlite3") return "sqlite";
  return "ansi";
}

function mapColumnInputType(sqlType: string): Field["inputType"] {
  const type = sqlType.toLowerCase();
  if (
    type.includes("int") ||
    type.includes("decimal") ||
    type.includes("numeric") ||
    type.includes("float") ||
    type.includes("double") ||
    type.includes("real") ||
    type.includes("number")
  ) {
    return "number";
  }
  if (type.includes("date") && !type.includes("datetime") && !type.includes("timestamp")) {
    return "date";
  }
  if (type.includes("time") || type.includes("timestamp") || type.includes("datetime")) {
    return "datetime-local";
  }
  if (type.includes("bool") || type.includes("bit(1)")) {
    return "checkbox";
  }
  return "text";
}

export function buildFilterFields(columnMeta: DbColumnMeta[]): Field[] {
  return columnMeta.map((col) => ({
    name: col.name,
    label: col.name,
    inputType: mapColumnInputType(col.type),
  }));
}

export function formatFilterWhere(
  filter: RuleGroupType | null | undefined,
  dbType: string,
): string | undefined {
  if (!isTableFilterActive(filter)) return undefined;
  const sql = formatQuery(filter!, {
    format: "sql",
    preset: sqlPresetForDbType(dbType),
  }).trim();
  return sql || undefined;
}

export function appendFilterRuleForColumn(
  filter: RuleGroupType | null | undefined,
  column: string,
): RuleGroupType {
  const base = ensureTableFilterQuery(filter);
  return ensureTableFilterQuery({
    ...base,
    rules: [...base.rules, { field: column, operator: "=", value: "" }],
  });
}

/** 从全局过滤中提取指定列的条件，供单列过滤弹层编辑 */
export function extractColumnFilter(
  filter: RuleGroupType | null | undefined,
  column: string,
): RuleGroupType {
  const rules: RuleType[] = [];
  const walk = (group: RuleGroupType) => {
    for (const rule of group.rules) {
      if (typeof rule === "string") continue;
      if (isRuleGroup(rule)) {
        walk(rule);
      } else if (String(rule.field) === column) {
        rules.push({ ...rule });
      }
    }
  };
  walk(ensureTableFilterQuery(filter));
  return ensureTableFilterQuery({ combinator: "and", rules });
}

/** 从过滤树中移除指定列的所有条件 */
export function removeColumnRules(filter: RuleGroupType, column: string): RuleGroupType {
  const strip = (group: RuleGroupType): RuleGroupType => {
    const rules: (RuleType | RuleGroupType | string)[] = [];
    for (const rule of group.rules) {
      if (typeof rule === "string") {
        rules.push(rule);
        continue;
      }
      if (isRuleGroup(rule)) {
        const nested = strip(rule);
        if (nested.rules.length > 0) {
          rules.push(nested);
        }
        continue;
      }
      if (String(rule.field) !== column) {
        rules.push(rule);
      }
    }
    return { ...group, rules: rules as RuleGroupType["rules"] };
  };
  return ensureTableFilterQuery(strip(filter));
}

/** 强制过滤树中所有叶子条件的 field 为指定列 */
export function forceColumnOnQuery(query: RuleGroupType, column: string): RuleGroupType {
  const map = (group: RuleGroupType): RuleGroupType => ({
    ...group,
    rules: group.rules.map((rule) => {
      if (typeof rule === "string") return rule;
      if (isRuleGroup(rule)) return map(rule);
      return { ...rule, field: column };
    }),
  });
  return ensureTableFilterQuery(map(query));
}

/** 将单列过滤草稿合并回全局过滤 */
export function mergeColumnFilter(
  base: RuleGroupType | null | undefined,
  column: string,
  columnDraft: RuleGroupType | null,
): RuleGroupType | null {
  const without = removeColumnRules(ensureTableFilterQuery(base), column);
  if (!columnDraft || !isTableFilterActive(columnDraft)) {
    return isTableFilterActive(without) ? without : null;
  }
  const forced = forceColumnOnQuery(columnDraft, column);
  const merged = ensureTableFilterQuery({
    ...without,
    rules: [...without.rules, ...forced.rules],
  });
  return isTableFilterActive(merged) ? merged : null;
}

function quoteSqlIdentifier(name: string, dbType: string): string {
  const normalized = dbType.toLowerCase();
  const safe = normalized === "mysql" || normalized === "mariadb"
    ? name.replace(/`/g, "")
    : name.replace(/"/g, "");
  if (normalized === "mysql" || normalized === "mariadb") {
    return `\`${safe}\``;
  }
  return `"${safe}"`;
}

export interface TablePreviewSqlContext {
  dbType: string;
  tableName: string;
  dbName?: string;
  filter?: RuleGroupType | null;
  sort?: SortState | null;
  page: number;
  pageSize: number;
  /** 指定 SELECT 列；省略或空则使用 * */
  selectColumns?: string[];
}

/** 组装与表预览后端一致的 SELECT 语句（含 QueryBuilder 过滤、排序与分页） */
export function buildTablePreviewSql({
  dbType,
  tableName,
  filter,
  sort,
  page,
  pageSize,
  selectColumns,
}: TablePreviewSqlContext): string {
  const tableRef = quoteSqlIdentifier(tableName, dbType);
  const whereClause = formatFilterWhere(filter, dbType);
  const whereSql = whereClause ? ` WHERE ${whereClause}` : "";
  const orderSql = sort ? ` ORDER BY ${buildOrderByClause(sort, dbType)}` : "";
  const limit = Math.max(0, pageSize);
  const offset = Math.max(0, page) * limit;
  const selectSql =
    selectColumns && selectColumns.length > 0
      ? selectColumns.map((col) => quoteSqlIdentifier(col, dbType)).join(", ")
      : "*";
  return `SELECT ${selectSql} FROM ${tableRef}${whereSql}${orderSql} LIMIT ${limit} OFFSET ${offset}`;
}
