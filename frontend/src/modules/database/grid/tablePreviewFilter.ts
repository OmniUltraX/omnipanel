import {
  formatQuery,
  prepareRuleGroup,
  type Field,
  type RuleGroupType,
  type RuleType,
} from "react-querybuilder";
import type { DbColumnMeta } from "../api";
import type { SortStates } from "../workspace/dbWorkspaceState";
import { buildOrderByClause, normalizeSortStates } from "../workspace/dbWorkspaceState";
import type { TableSchema } from "../types";
import type { TableColumnRelation } from "./tableColumnRelation";
import {
  buildRelationDisplayColumnLabel,
  isRelationDisplayColumn,
  relationDisplayColumnId,
  relationSourceColumn,
  resolveRelationDisplayFieldName,
} from "./tableColumnRelation";

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

/** 面板眼睛开关映射到 RQB 原生 muted：导出 SQL 时自动排除，对象本身保留 */
export function isMutedFilterNode(rule: RuleType | RuleGroupType | string): boolean {
  return typeof rule !== "string" && rule.muted === true;
}

/** 是否有实际生效（非 muted）的叶子条件；全停用视为未激活 */
export function isTableFilterActive(filter: RuleGroupType | null | undefined): boolean {
  if (!filter) return false;
  const walk = (group: RuleGroupType): boolean => {
    for (const rule of group.rules) {
      if (typeof rule === "string") continue;
      if (isMutedFilterNode(rule)) continue;
      if (isRuleGroup(rule)) {
        if (walk(rule)) return true;
      } else {
        return true;
      }
    }
    return false;
  };
  return walk(filter);
}

/** 结构性判断：是否有任何规则（含 muted 停用的），用于应用时保留停用行 */
export function hasTableFilterRules(filter: RuleGroupType | null | undefined): boolean {
  if (!filter) return false;
  const walk = (group: RuleGroupType): boolean => {
    for (const rule of group.rules) {
      if (typeof rule === "string") continue;
      if (isRuleGroup(rule)) {
        if (walk(rule)) return true;
      } else {
        return true;
      }
    }
    return false;
  };
  return walk(filter);
}

function isRuleGroup(rule: RuleType | RuleGroupType): rule is RuleGroupType {
  return "rules" in rule;
}

/** 过滤值是否为空（空串/空白串/空数组/null 均视为未填写） */
export function isEmptyFilterValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) {
    return value.length === 0 || value.every((item) => isEmptyFilterValue(item));
  }
  return false;
}

/** 操作符是否需要填写值（NULL / NOT NULL 类操作符不需要） */
export function filterOperatorNeedsValue(operator: unknown): boolean {
  const op = typeof operator === "string" ? operator.toLowerCase() : "";
  return op !== "null" && op !== "notnull" && op !== "isnull" && op !== "isnotnull";
}

/**
 * 移除「需要值但值为空」的叶子条件，递归处理嵌套组。
 * 用于避免空值被格式化成 `col = ''`（例如 MySQL DATETIME 直接报 1525）。
 * muted 停用的行始终保留（SQL 导出时由 RQB 自动排除，再次打开可恢复）。
 * 清空后无剩余条件时返回 null。
 */
export function pruneEmptyFilterRules(
  filter: RuleGroupType | null | undefined,
): RuleGroupType | null {
  if (!filter) return null;
  const prune = (group: RuleGroupType): RuleGroupType => {
    const rules: (RuleType | RuleGroupType | string)[] = [];
    for (const rule of group.rules) {
      if (typeof rule === "string") {
        rules.push(rule);
        continue;
      }
      if (isMutedFilterNode(rule)) {
        rules.push(rule);
        continue;
      }
      if (isRuleGroup(rule)) {
        const nested = prune(rule);
        if (nested.rules.length > 0) rules.push(nested);
        continue;
      }
      if (filterOperatorNeedsValue(rule.operator) && isEmptyFilterValue(rule.value)) {
        continue;
      }
      rules.push(rule);
    }
    return { ...group, rules: rules as RuleGroupType["rules"] };
  };
  const pruned = prune(filter);
  return hasTableFilterRules(pruned) ? pruned : null;
}

export function getFilterColumnNames(filter: RuleGroupType | null | undefined): Set<string> {
  const names = new Set<string>();
  const effective = pruneEmptyFilterRules(filter);
  if (!effective) return names;

  const walk = (group: RuleGroupType) => {
    for (const rule of group.rules) {
      if (typeof rule === "string") continue;
      if (isMutedFilterNode(rule)) continue;
      if (isRuleGroup(rule)) {
        walk(rule);
      } else if (rule.field) {
        names.add(String(rule.field));
      }
    }
  };
  walk(effective);
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

function isBigIntColumnType(sqlType: string): boolean {
  const type = sqlType.toLowerCase();
  return (
    type.includes("bigint") ||
    type.includes("bigserial") ||
    type === "int8" ||
    type === "serial8"
  );
}

function mapColumnInputType(sqlType: string): Field["inputType"] {
  const type = sqlType.toLowerCase();
  if (isBigIntColumnType(type)) {
    return "bigint";
  }
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

/** 表预览过滤字段：主表列 + 关联显示列（`__rel__:源列`） */
export function buildPreviewFilterFields(
  columnMeta: DbColumnMeta[],
  columnRelations: Record<string, TableColumnRelation>,
  relationTables?: TableSchema[],
): Field[] {
  const fields = buildFilterFields(columnMeta);
  if (Object.keys(columnRelations).length === 0) {
    return fields;
  }
  const tableByName = new Map((relationTables ?? []).map((table) => [table.name, table]));
  for (const [sourceColumn, relation] of Object.entries(columnRelations)) {
    const relatedTable = tableByName.get(relation.tableName);
    const displayField = resolveRelationDisplayFieldName(relation, relatedTable);
    const displayColumn = relatedTable?.columns.find((column) => column.name === displayField);
    fields.push({
      name: relationDisplayColumnId(sourceColumn),
      label: buildRelationDisplayColumnLabel(relation, relatedTable),
      inputType: mapColumnInputType(displayColumn?.type ?? "text"),
    });
  }
  return fields;
}

export function filterUsesRelationColumns(
  filter: RuleGroupType | null | undefined,
  columnRelations: Record<string, TableColumnRelation>,
): boolean {
  if (Object.keys(columnRelations).length === 0) return false;
  for (const column of getFilterColumnNames(filter)) {
    if (!isRelationDisplayColumn(column)) continue;
    const sourceColumn = relationSourceColumn(column);
    if (sourceColumn && columnRelations[sourceColumn]) return true;
  }
  return false;
}

export function sortUsesRelationColumn(sort: SortStates | null | undefined): boolean {
  return normalizeSortStates(sort).some((entry) => isRelationDisplayColumn(entry.column));
}

/** 过滤或排序涉及关联显示列时，需走 JOIN 预览查询 */
export function shouldUseRelationJoinPreview(
  columnRelations: Record<string, TableColumnRelation>,
  filter: RuleGroupType | null | undefined,
  sort: SortStates | null | undefined,
): boolean {
  if (Object.keys(columnRelations).length === 0) return false;
  return (
    filterUsesRelationColumns(pruneEmptyFilterRules(filter), columnRelations) ||
    sortUsesRelationColumn(sort)
  );
}

export function formatFilterWhere(
  filter: RuleGroupType | null | undefined,
  dbType: string,
  columnMeta?: DbColumnMeta[],
): string | undefined {
  const effective = pruneEmptyFilterRules(filter);
  // 全停用（muted）时 RQB 会输出 `1 = 1` 占位，直接视为无过滤，保持 WHERE 栏干净
  if (!effective || !isTableFilterActive(effective)) return undefined;
  const fields = columnMeta?.length ? buildFilterFields(columnMeta) : undefined;
  const sql = formatQuery(effective, {
    format: "sql",
    preset: sqlPresetForDbType(dbType),
    ...(fields
      ? { fields, parseNumbers: "strict-limited" as const }
      : { parseNumbers: false }),
  }).trim();
  if (!sql) return undefined;
  // react-querybuilder 会包一层外括号，表数据 WHERE 栏无需展示，否则回车规范化后难再解析/编辑
  return stripWrappingParens(sql);
}

/** 去掉 formatQuery 产生的最外层配对括号（保留表达式内部括号）。 */
function stripWrappingParens(sql: string): string {
  let s = sql.trim();
  while (s.length >= 2 && s.startsWith("(") && s.endsWith(")")) {
    let depth = 0;
    let inStr: "'" | '"' | null = null;
    let wrapsWhole = true;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (ch === inStr && s[i - 1] !== "\\") inStr = null;
        continue;
      }
      if (ch === "'" || ch === '"') {
        inStr = ch;
        continue;
      }
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0 && i !== s.length - 1) {
          wrapsWhole = false;
          break;
        }
      }
    }
    if (!wrapsWhole || depth !== 0) break;
    s = s.slice(1, -1).trim();
  }
  return s;
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

/** 右键快捷筛选种类（图1子菜单） */
export type QuickFilterKind =
  | "equals"
  | "notEquals"
  | "contains"
  | "notContains"
  | "lt"
  | "gt"
  | "isNull"
  | "isNotNull";

function isNullishFilterValue(value: unknown): boolean {
  return value === null || value === undefined;
}

function normalizeQuickFilterValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object" && value !== null) {
    try {
      const json = JSON.stringify(value);
      if (json !== undefined) return json;
    } catch {
      // fall through
    }
    return String(value);
  }
  return value ?? null;
}

/** 快捷筛选是否可用（NULL 时仅允许等于/排除/NULL 相关） */
export function isQuickFilterKindEnabled(kind: QuickFilterKind, value: unknown): boolean {
  if (isNullishFilterValue(value)) {
    return kind === "equals" || kind === "notEquals" || kind === "isNull" || kind === "isNotNull";
  }
  return true;
}

/** 为指定列+单元格值构建单条快捷筛选规则；NULL 自动转为 IS NULL / IS NOT NULL */
export function buildQuickFilterRule(
  column: string,
  kind: QuickFilterKind,
  value: unknown,
): RuleType | null {
  if (!column) return null;
  if (kind === "isNull") return { field: column, operator: "null", value: null };
  if (kind === "isNotNull") return { field: column, operator: "notNull", value: null };
  if (isNullishFilterValue(value)) {
    if (kind === "equals") return { field: column, operator: "null", value: null };
    if (kind === "notEquals") return { field: column, operator: "notNull", value: null };
    return null;
  }
  const normalized = normalizeQuickFilterValue(value);
  switch (kind) {
    case "equals":
      return { field: column, operator: "=", value: normalized };
    case "notEquals":
      return { field: column, operator: "!=", value: normalized };
    case "contains":
      return { field: column, operator: "contains", value: String(normalized ?? "") };
    case "notContains":
      return { field: column, operator: "doesNotContain", value: String(normalized ?? "") };
    case "lt":
      return { field: column, operator: "<", value: normalized };
    case "gt":
      return { field: column, operator: ">", value: normalized };
    default:
      return null;
  }
}

/** AND 追加快捷筛选到全局过滤并立即生效；不可用时返回原过滤 */
export function appendQuickFilterRule(
  filter: RuleGroupType | null | undefined,
  column: string,
  kind: QuickFilterKind,
  value: unknown,
): RuleGroupType | null {
  const rule = buildQuickFilterRule(column, kind, value);
  if (!rule) return isTableFilterActive(filter) ? ensureTableFilterQuery(filter!) : filter ?? null;
  const base = ensureTableFilterQuery(filter);
  const merged = ensureTableFilterQuery({
    ...base,
    combinator: "and",
    rules: [...base.rules, rule],
  });
  return isTableFilterActive(merged) ? merged : null;
}

/** 清除指定列的全部条件；无剩余时返回 null */
export function clearColumnFilter(
  filter: RuleGroupType | null | undefined,
  column: string,
): RuleGroupType | null {
  if (!hasTableFilterRules(filter)) return null;
  const without = removeColumnRules(ensureTableFilterQuery(filter!), column);
  return hasTableFilterRules(without) ? without : null;
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
  // 结构性判断（含 muted）：全停用的草稿也要保留行，以便再次打开恢复
  if (!columnDraft || !hasTableFilterRules(columnDraft)) {
    return hasTableFilterRules(without) ? without : null;
  }
  const forced = forceColumnOnQuery(columnDraft, column);
  // 草稿组合符与全局不一致且有多条时包成子组，避免 OR 被拍平成 AND
  const nestAsGroup =
    forced.rules.length > 1 &&
    (forced.combinator ?? "and") !== (without.combinator ?? "and");
  const merged = ensureTableFilterQuery({
    ...without,
    rules: nestAsGroup ? [...without.rules, forced] : [...without.rules, ...forced.rules],
  });
  return hasTableFilterRules(merged) ? merged : null;
}

/** 拖拽排序：把 fromId 移动到 targetId 的 before/after，返回新 id 顺序 */
export function reorderIds(
  ids: string[],
  fromId: string,
  targetId: string,
  pos: "before" | "after",
): string[] {
  if (fromId === targetId) return ids;
  if (!ids.includes(fromId) || !ids.includes(targetId)) return ids;
  const next = ids.filter((id) => id !== fromId);
  const at = next.indexOf(targetId) + (pos === "after" ? 1 : 0);
  next.splice(at, 0, fromId);
  return next;
}

function quoteSqlIdentifier(name: string, dbType: string): string {
  const normalized = dbType.toLowerCase();
  if (normalized.includes("sqlserver") || normalized.includes("mssql")) {
    return name
      .split(".")
      .map((part) => `[${part.replaceAll("]", "]]")}]`)
      .join(".");
  }
  const safe = normalized === "mysql" || normalized === "mariadb"
    ? name.replace(/`/g, "")
    : name.replace(/"/g, "");
  if (normalized === "mysql" || normalized === "mariadb") {
    return `\`${safe}\``;
  }
  return `"${safe}"`;
}

function previewPaginationSql(
  dbType: string,
  limit: number,
  offset: number,
  hasOrder: boolean,
): { extraOrder: string; suffix: string } {
  const engine = dbType.trim().toLowerCase();
  if (engine === "cassandra") {
    return { extraOrder: "", suffix: ` LIMIT ${limit}` };
  }
  if (
    engine.includes("sqlserver") ||
    engine.includes("mssql") ||
    engine === "oracle" ||
    engine === "db2"
  ) {
    const extraOrder =
      hasOrder || engine === "oracle" || engine === "db2" ? "" : " ORDER BY (SELECT NULL)";
    return {
      extraOrder,
      suffix: ` OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`,
    };
  }
  return { extraOrder: "", suffix: ` LIMIT ${limit} OFFSET ${offset}` };
}

export interface TablePreviewSqlContext {
  dbType: string;
  tableName: string;
  dbName?: string;
  filter?: RuleGroupType | null;
  sort?: SortStates | null;
  page: number;
  pageSize: number;
  /** 指定 SELECT 列；省略或空则使用 * */
  selectColumns?: string[];
  /** 列元数据，用于 BIGINT 等大整数过滤精度 */
  columnMeta?: DbColumnMeta[];
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
  columnMeta,
}: TablePreviewSqlContext): string {
  const engine = dbType.trim().toLowerCase();
  const whereClause = formatFilterWhere(filter, dbType, columnMeta);
  const limit = Math.max(0, pageSize);
  const offset = Math.max(0, page) * limit;
  if (engine === "neo4j") {
    const label = /^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)
      ? tableName
      : `\`${tableName.replaceAll("`", "``")}\``;
    const whereSql = whereClause ? ` WHERE ${whereClause}` : "";
    return `MATCH (n:${label})${whereSql} RETURN n SKIP ${offset} LIMIT ${limit}`;
  }
  const tableRef = quoteSqlIdentifier(tableName, dbType);
  const whereSql = whereClause ? ` WHERE ${whereClause}` : "";
  const sorts = normalizeSortStates(sort);
  const hasOrder = sorts.length > 0;
  const orderSql = hasOrder ? ` ORDER BY ${buildOrderByClause(sorts, dbType)}` : "";
  const selectSql =
    selectColumns && selectColumns.length > 0
      ? selectColumns.map((col) => quoteSqlIdentifier(col, dbType)).join(", ")
      : "*";
  const paging = previewPaginationSql(dbType, limit, offset, hasOrder);
  return `SELECT ${selectSql} FROM ${tableRef}${whereSql}${orderSql}${paging.extraOrder}${paging.suffix}`;
}

/** 为当前表生成简单的 SELECT * 语句（SQL 查询 Tab 预填用） */
export function buildSelectAllFromTableSql(dbType: string, tableName: string): string {
  const engine = dbType.trim().toLowerCase();
  if (engine === "neo4j") {
    const label = /^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)
      ? tableName
      : `\`${tableName.replaceAll("`", "``")}\``;
    return `MATCH (n:${label}) RETURN n LIMIT 50;`;
  }
  const tableRef = quoteSqlIdentifier(tableName, dbType);
  return `SELECT * FROM ${tableRef};`;
}

export interface RelationJoinPlan {
  sourceColumn: string;
  joinAlias: string;
  relation: TableColumnRelation;
  displayField: string;
  displayColumnId: string;
}

export function buildRelationJoinPlans(
  columnRelations: Record<string, TableColumnRelation>,
  relationTables?: TableSchema[],
): RelationJoinPlan[] {
  const tableByName = new Map((relationTables ?? []).map((table) => [table.name, table]));
  const plans: RelationJoinPlan[] = [];
  let joinIndex = 0;
  for (const [sourceColumn, relation] of Object.entries(columnRelations)) {
    const relatedTable = tableByName.get(relation.tableName);
    const displayField = resolveRelationDisplayFieldName(relation, relatedTable);
    plans.push({
      sourceColumn,
      joinAlias: `rel_${joinIndex++}`,
      relation,
      displayField,
      displayColumnId: relationDisplayColumnId(sourceColumn),
    });
  }
  return plans;
}

function buildRelationPreviewFromSql(
  dbType: string,
  tableName: string,
  plans: RelationJoinPlan[],
  mainAlias = "t",
): string {
  const tableRef = quoteSqlIdentifier(tableName, dbType);
  if (plans.length === 0) return tableRef;
  const mainAliasRef = quoteSqlIdentifier(mainAlias, dbType);
  const joinParts = plans.map((plan) => {
    const joinAliasRef = quoteSqlIdentifier(plan.joinAlias, dbType);
    const relatedTableRef = quoteSqlIdentifier(plan.relation.tableName, dbType);
    const joinFieldRef = quoteSqlIdentifier(plan.relation.fieldName, dbType);
    const sourceFieldRef = quoteSqlIdentifier(plan.sourceColumn, dbType);
    return `LEFT JOIN ${relatedTableRef} AS ${joinAliasRef} ON ${mainAliasRef}.${sourceFieldRef} = ${joinAliasRef}.${joinFieldRef}`;
  });
  return `${tableRef} AS ${mainAliasRef}\n${joinParts.join("\n")}`;
}

function formatFilterWhereWithRelations(
  filter: RuleGroupType | null | undefined,
  dbType: string,
  columnMeta: DbColumnMeta[] | undefined,
  columnRelations: Record<string, TableColumnRelation>,
  relationTables?: TableSchema[],
): string | undefined {
  const effective = pruneEmptyFilterRules(filter);
  if (!effective) return undefined;
  const fields =
    columnMeta?.length || Object.keys(columnRelations).length > 0
      ? buildPreviewFilterFields(columnMeta ?? [], columnRelations, relationTables)
      : undefined;
  const sql = formatQuery(effective, {
    format: "sql",
    preset: sqlPresetForDbType(dbType),
    ...(fields
      ? { fields, parseNumbers: "strict-limited" as const }
      : { parseNumbers: false }),
  }).trim();
  return sql || undefined;
}

function qualifyFilterWhereWithRelations(
  filter: RuleGroupType | null | undefined,
  dbType: string,
  mainAlias: string,
  columnMeta: DbColumnMeta[] | undefined,
  columnRelations: Record<string, TableColumnRelation>,
  relationTables: TableSchema[] | undefined,
  plans: RelationJoinPlan[],
): string | undefined {
  const sql = formatFilterWhereWithRelations(
    filter,
    dbType,
    columnMeta,
    columnRelations,
    relationTables,
  );
  if (!sql) return undefined;
  const columns = getFilterColumnNames(filter ?? { combinator: "and", rules: [] });
  const mainAliasRef = quoteSqlIdentifier(mainAlias, dbType);
  let qualified = sql;
  for (const plan of [...plans].sort((a, b) => b.displayColumnId.length - a.displayColumnId.length)) {
    const quotedRelCol = quoteSqlIdentifier(plan.displayColumnId, dbType);
    const joinRef = `${quoteSqlIdentifier(plan.joinAlias, dbType)}.${quoteSqlIdentifier(plan.displayField, dbType)}`;
    qualified = qualified.split(quotedRelCol).join(joinRef);
    qualified = qualified.split(plan.displayColumnId).join(joinRef);
  }
  for (const column of [...columns].sort((a, b) => b.length - a.length)) {
    if (isRelationDisplayColumn(column)) continue;
    const quoted = quoteSqlIdentifier(column, dbType);
    qualified = qualified.split(quoted).join(`${mainAliasRef}.${quoted}`);
  }
  return qualified;
}

function qualifyFilterWhereForAlias(
  filter: RuleGroupType | null | undefined,
  dbType: string,
  tableAlias: string,
  columnMeta?: DbColumnMeta[],
): string | undefined {
  const sql = formatFilterWhere(filter, dbType, columnMeta);
  if (!sql) return undefined;
  const columns = getFilterColumnNames(filter ?? { combinator: "and", rules: [] });
  let qualified = sql;
  for (const column of [...columns].sort((a, b) => b.length - a.length)) {
    const quoted = quoteSqlIdentifier(column, dbType);
    qualified = qualified.split(quoted).join(`${tableAlias}.${quoted}`);
  }
  return qualified;
}

function buildRelationOrderBySql(
  sort: SortStates | null | undefined,
  dbType: string,
  mainAlias: string,
  plans: RelationJoinPlan[],
): string {
  const sorts = normalizeSortStates(sort);
  if (sorts.length === 0) return "";
  const mainAliasRef = quoteSqlIdentifier(mainAlias, dbType);
  const parts: string[] = [];
  for (const entry of sorts) {
    if (isRelationDisplayColumn(entry.column)) {
      const sourceColumn = relationSourceColumn(entry.column);
      const plan = sourceColumn
        ? plans.find((item) => item.sourceColumn === sourceColumn)
        : undefined;
      if (!plan) continue;
      const joinAliasRef = quoteSqlIdentifier(plan.joinAlias, dbType);
      const displayFieldRef = quoteSqlIdentifier(plan.displayField, dbType);
      parts.push(`${joinAliasRef}.${displayFieldRef} ${entry.direction.toUpperCase()}`);
      continue;
    }
    const quoted = quoteSqlIdentifier(entry.column, dbType);
    parts.push(`${mainAliasRef}.${quoted} ${entry.direction.toUpperCase()}`);
  }
  if (parts.length === 0) return "";
  return ` ORDER BY ${parts.join(", ")}`;
}

export interface RelationPreviewSqlContext {
  dbType: string;
  tableName: string;
  filter?: RuleGroupType | null;
  sort?: SortStates | null;
  page: number;
  pageSize: number;
  columnRelations: Record<string, TableColumnRelation>;
  relationTables?: TableSchema[];
  columnMeta?: DbColumnMeta[];
}

/** 含 JOIN 的表预览数据 SQL（关联列以 `__rel__:源列` 别名返回） */
export function buildTablePreviewDataSqlWithRelations({
  dbType,
  tableName,
  filter,
  sort,
  page,
  pageSize,
  columnRelations,
  relationTables,
  columnMeta,
}: RelationPreviewSqlContext): string {
  const mainAlias = "t";
  const plans = buildRelationJoinPlans(columnRelations, relationTables);
  const fromSql = buildRelationPreviewFromSql(dbType, tableName, plans, mainAlias);
  const mainAliasRef = quoteSqlIdentifier(mainAlias, dbType);
  const selectParts = [`${mainAliasRef}.*`];
  for (const plan of plans) {
    const joinAliasRef = quoteSqlIdentifier(plan.joinAlias, dbType);
    const displayFieldRef = quoteSqlIdentifier(plan.displayField, dbType);
    const outputAlias = quoteSqlIdentifier(plan.displayColumnId, dbType);
    selectParts.push(`${joinAliasRef}.${displayFieldRef} AS ${outputAlias}`);
  }
  const qualifiedWhere = qualifyFilterWhereWithRelations(
    filter,
    dbType,
    mainAlias,
    columnMeta,
    columnRelations,
    relationTables,
    plans,
  );
  const whereSql = qualifiedWhere ? ` WHERE ${qualifiedWhere}` : "";
  const orderSql = buildRelationOrderBySql(sort, dbType, mainAlias, plans);
  const limit = Math.max(0, pageSize);
  const offset = Math.max(0, page) * limit;
  return `SELECT ${selectParts.join(", ")} FROM ${fromSql}${whereSql}${orderSql} LIMIT ${limit} OFFSET ${offset}`;
}

/** 含 JOIN 的表预览计数 SQL */
export function buildTablePreviewCountSqlWithRelations({
  dbType,
  tableName,
  filter,
  columnRelations,
  relationTables,
  columnMeta,
}: Omit<RelationPreviewSqlContext, "page" | "pageSize" | "sort"> &
  Pick<RelationPreviewSqlContext, "filter">): string {
  const mainAlias = "t";
  const plans = buildRelationJoinPlans(columnRelations, relationTables);
  const fromSql = buildRelationPreviewFromSql(dbType, tableName, plans, mainAlias);
  const qualifiedWhere = qualifyFilterWhereWithRelations(
    filter,
    dbType,
    mainAlias,
    columnMeta,
    columnRelations,
    relationTables,
    plans,
  );
  const whereSql = qualifiedWhere ? ` WHERE ${qualifiedWhere}` : "";
  return `SELECT COUNT(*) FROM ${fromSql}${whereSql}`;
}

export interface TablePreviewRelationSqlContext extends TablePreviewSqlContext {
  columnRelations: Record<string, TableColumnRelation>;
  relationTables?: TableSchema[];
  /** 当前网格可见列（含关联显示列） */
  visibleGridColumns: string[];
}

/** 组装含 LEFT JOIN 的表预览 SQL（同步关联显示列，供复制 SQL） */
export function buildTablePreviewSqlWithRelations({
  dbType,
  tableName,
  filter,
  sort,
  page,
  pageSize,
  columnRelations,
  relationTables,
  visibleGridColumns,
  columnMeta,
}: TablePreviewRelationSqlContext): string {
  const mainAlias = "t";
  const plans = buildRelationJoinPlans(columnRelations, relationTables);
  const planByDisplayColumnId = new Map(plans.map((plan) => [plan.displayColumnId, plan]));
  const mainAliasRef = quoteSqlIdentifier(mainAlias, dbType);
  const tableByName = new Map((relationTables ?? []).map((table) => [table.name, table]));
  const selectParts: string[] = [];
  const usedJoinAliases = new Set<string>();

  for (const column of visibleGridColumns) {
    if (isRelationDisplayColumn(column)) {
      const plan = planByDisplayColumnId.get(column);
      if (!plan) continue;
      usedJoinAliases.add(plan.joinAlias);
      const joinAliasRef = quoteSqlIdentifier(plan.joinAlias, dbType);
      const displayFieldRef = quoteSqlIdentifier(plan.displayField, dbType);
      const relatedTable = tableByName.get(plan.relation.tableName);
      const outputAlias = quoteSqlIdentifier(
        buildRelationDisplayColumnLabel(plan.relation, relatedTable),
        dbType,
      );
      selectParts.push(`${joinAliasRef}.${displayFieldRef} AS ${outputAlias}`);
      continue;
    }
    selectParts.push(`${mainAliasRef}.${quoteSqlIdentifier(column, dbType)}`);
  }

  const joinPlansForFrom = shouldUseRelationJoinPreview(columnRelations, filter, sort)
    ? plans
    : plans.filter((plan) => usedJoinAliases.has(plan.joinAlias));
  const fromSql = buildRelationPreviewFromSql(dbType, tableName, joinPlansForFrom, mainAlias);
  const selectSql =
    selectParts.length > 0 ? selectParts.join(", ") : `${mainAliasRef}.*`;
  const needsQualifiedAlias =
    shouldUseRelationJoinPreview(columnRelations, filter, sort) || joinPlansForFrom.length > 0;
  const qualifiedWhere = needsQualifiedAlias
    ? qualifyFilterWhereWithRelations(
        filter,
        dbType,
        mainAlias,
        columnMeta,
        columnRelations,
        relationTables,
        joinPlansForFrom.length > 0 ? joinPlansForFrom : plans,
      )
    : qualifyFilterWhereForAlias(
        filter,
        dbType,
        mainAliasRef,
        columnMeta,
      );
  const whereSql = qualifiedWhere ? ` WHERE ${qualifiedWhere}` : "";
  const sorts = normalizeSortStates(sort);
  const orderSql = sorts.length > 0
    ? needsQualifiedAlias
      ? buildRelationOrderBySql(
          sorts,
          dbType,
          mainAlias,
          joinPlansForFrom.length > 0 ? joinPlansForFrom : plans,
        )
      : ` ORDER BY ${buildOrderByClause(sorts, dbType)}`
    : "";
  const limit = Math.max(0, pageSize);
  const offset = Math.max(0, page) * limit;
  return `SELECT ${selectSql} FROM ${fromSql}${whereSql}${orderSql} LIMIT ${limit} OFFSET ${offset}`;
}
