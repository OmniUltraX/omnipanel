import {
  formatQuery,
  prepareRuleGroup,
  type Field,
  type RuleGroupType,
  type RuleType,
} from "react-querybuilder";
import type { DbColumnMeta } from "../api";
import type { SortState } from "../workspace/dbWorkspaceState";
import { buildOrderByClause } from "../workspace/dbWorkspaceState";
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

export function sortUsesRelationColumn(sort: SortState | null | undefined): boolean {
  return Boolean(sort && isRelationDisplayColumn(sort.column));
}

/** 过滤或排序涉及关联显示列时，需走 JOIN 预览查询 */
export function shouldUseRelationJoinPreview(
  columnRelations: Record<string, TableColumnRelation>,
  filter: RuleGroupType | null | undefined,
  sort: SortState | null | undefined,
): boolean {
  if (Object.keys(columnRelations).length === 0) return false;
  return filterUsesRelationColumns(filter, columnRelations) || sortUsesRelationColumn(sort);
}

export function formatFilterWhere(
  filter: RuleGroupType | null | undefined,
  dbType: string,
  columnMeta?: DbColumnMeta[],
): string | undefined {
  if (!isTableFilterActive(filter)) return undefined;
  const fields = columnMeta?.length ? buildFilterFields(columnMeta) : undefined;
  const sql = formatQuery(filter!, {
    format: "sql",
    preset: sqlPresetForDbType(dbType),
    ...(fields
      ? { fields, parseNumbers: "strict-limited" as const }
      : { parseNumbers: false }),
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
  const tableRef = quoteSqlIdentifier(tableName, dbType);
  const whereClause = formatFilterWhere(filter, dbType, columnMeta);
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

/** 为当前表生成简单的 SELECT * 语句（SQL 查询 Tab 预填用） */
export function buildSelectAllFromTableSql(dbType: string, tableName: string): string {
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
  if (!isTableFilterActive(filter)) return undefined;
  const fields =
    columnMeta?.length || Object.keys(columnRelations).length > 0
      ? buildPreviewFilterFields(columnMeta ?? [], columnRelations, relationTables)
      : undefined;
  const sql = formatQuery(filter!, {
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
  sort: SortState | null | undefined,
  dbType: string,
  mainAlias: string,
  plans: RelationJoinPlan[],
): string {
  if (!sort) return "";
  const mainAliasRef = quoteSqlIdentifier(mainAlias, dbType);
  if (isRelationDisplayColumn(sort.column)) {
    const sourceColumn = relationSourceColumn(sort.column);
    const plan = sourceColumn ? plans.find((entry) => entry.sourceColumn === sourceColumn) : undefined;
    if (!plan) return "";
    const joinAliasRef = quoteSqlIdentifier(plan.joinAlias, dbType);
    const displayFieldRef = quoteSqlIdentifier(plan.displayField, dbType);
    return ` ORDER BY ${joinAliasRef}.${displayFieldRef} ${sort.direction.toUpperCase()}`;
  }
  const quoted = quoteSqlIdentifier(sort.column, dbType);
  return ` ORDER BY ${mainAliasRef}.${quoted} ${sort.direction.toUpperCase()}`;
}

export interface RelationPreviewSqlContext {
  dbType: string;
  tableName: string;
  filter?: RuleGroupType | null;
  sort?: SortState | null;
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
  const orderSql = sort
    ? needsQualifiedAlias
      ? buildRelationOrderBySql(
          sort,
          dbType,
          mainAlias,
          joinPlansForFrom.length > 0 ? joinPlansForFrom : plans,
        )
      : ` ORDER BY ${buildOrderByClause(sort, dbType)}`
    : "";
  const limit = Math.max(0, pageSize);
  const offset = Math.max(0, page) * limit;
  return `SELECT ${selectSql} FROM ${fromSql}${whereSql}${orderSql} LIMIT ${limit} OFFSET ${offset}`;
}
