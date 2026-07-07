export type SqlFunctionCategory =
  | "aggregate"
  | "string"
  | "date"
  | "math"
  | "window"
  | "conversion"
  | "conditional";

export type SqlFunctionDialectTag = "mysql" | "postgresql" | "sqlite" | "common";

export interface SqlFunctionDef {
  name: string;
  signature: string;
  insertSnippet: string;
  params: { name: string; desc: string; optional?: boolean }[];
  returns?: string;
  description: string;
  category: SqlFunctionCategory;
  dialects: SqlFunctionDialectTag[];
}

function fn(
  name: string,
  signature: string,
  insertSnippet: string,
  description: string,
  category: SqlFunctionCategory,
  dialects: SqlFunctionDialectTag[],
  params: SqlFunctionDef["params"] = [],
  returns?: string,
): SqlFunctionDef {
  return { name, signature, insertSnippet, description, category, dialects, params, returns };
}

const SQL_FUNCTION_CATALOG: SqlFunctionDef[] = [
  fn("COUNT", "COUNT(expr)", "COUNT(${1:*})", "计数", "aggregate", ["common"], [
    { name: "expr", desc: "表达式或 *" },
  ], "数值"),
  fn("SUM", "SUM(expr)", "SUM(${1:column})", "求和", "aggregate", ["common"], [
    { name: "expr", desc: "数值表达式" },
  ]),
  fn("AVG", "AVG(expr)", "AVG(${1:column})", "平均值", "aggregate", ["common"], [
    { name: "expr", desc: "数值表达式" },
  ]),
  fn("MIN", "MIN(expr)", "MIN(${1:column})", "最小值", "aggregate", ["common"], [
    { name: "expr", desc: "表达式" },
  ]),
  fn("MAX", "MAX(expr)", "MAX(${1:column})", "最大值", "aggregate", ["common"], [
    { name: "expr", desc: "表达式" },
  ]),
  fn("COALESCE", "COALESCE(val, ...)", "COALESCE(${1:expr}, ${2:fallback})", "返回第一个非 NULL 值", "conditional", ["common"], [
    { name: "val", desc: "待检测值" },
    { name: "fallback", desc: "备用值" },
  ]),
  fn("NULLIF", "NULLIF(expr1, expr2)", "NULLIF(${1:a}, ${2:b})", "相等时返回 NULL", "conditional", ["common"], [
    { name: "expr1", desc: "表达式 1" },
    { name: "expr2", desc: "表达式 2" },
  ]),
  fn("CAST", "CAST(expr AS type)", "CAST(${1:expr} AS ${2:type})", "类型转换", "conversion", ["common"], [
    { name: "expr", desc: "表达式" },
    { name: "type", desc: "目标类型" },
  ]),
  fn("CONCAT", "CONCAT(str, ...)", "CONCAT(${1:a}, ${2:b})", "连接字符串", "string", ["mysql", "common"], [
    { name: "str", desc: "字符串" },
  ]),
  fn("UPPER", "UPPER(str)", "UPPER(${1:str})", "转大写", "string", ["common"], [{ name: "str", desc: "字符串" }]),
  fn("LOWER", "LOWER(str)", "LOWER(${1:str})", "转小写", "string", ["common"], [{ name: "str", desc: "字符串" }]),
  fn("TRIM", "TRIM(str)", "TRIM(${1:str})", "去除首尾空白", "string", ["common"], [{ name: "str", desc: "字符串" }]),
  fn("LENGTH", "LENGTH(str)", "LENGTH(${1:str})", "字符串长度", "string", ["common"], [{ name: "str", desc: "字符串" }]),
  fn("SUBSTRING", "SUBSTRING(str, pos, len)", "SUBSTRING(${1:str}, ${2:pos}, ${3:len})", "截取子串", "string", ["common"], [
    { name: "str", desc: "源字符串" },
    { name: "pos", desc: "起始位置" },
    { name: "len", desc: "长度", optional: true },
  ]),
  fn("NOW", "NOW()", "NOW()", "当前日期时间", "date", ["mysql", "common"], [], "DATETIME"),
  fn("CURDATE", "CURDATE()", "CURDATE()", "当前日期", "date", ["mysql"], [], "DATE"),
  fn("CURTIME", "CURTIME()", "CURTIME()", "当前时间", "date", ["mysql"], [], "TIME"),
  fn(
    "DATE_FORMAT",
    "DATE_FORMAT(date, format)",
    "DATE_FORMAT(${1:date}, ${2:'%Y-%m-%d'})",
    "格式化日期",
    "date",
    ["mysql"],
    [
      { name: "date", desc: "日期表达式" },
      { name: "format", desc: "格式串" },
    ],
    "STRING",
  ),
  fn(
    "IFNULL",
    "IFNULL(expr, alt)",
    "IFNULL(${1:expr}, ${2:alt})",
    "NULL 时用备用值",
    "conditional",
    ["mysql", "sqlite"],
    [
      { name: "expr", desc: "表达式" },
      { name: "alt", desc: "备用值" },
    ],
  ),
  fn(
    "GROUP_CONCAT",
    "GROUP_CONCAT(expr)",
    "GROUP_CONCAT(${1:column})",
    "聚合连接字符串",
    "aggregate",
    ["mysql", "sqlite"],
    [{ name: "expr", desc: "表达式" }],
  ),
  fn(
    "JSON_EXTRACT",
    "JSON_EXTRACT(json, path)",
    "JSON_EXTRACT(${1:json}, ${2:'$.path'})",
    "提取 JSON 字段",
    "conversion",
    ["mysql", "sqlite"],
    [
      { name: "json", desc: "JSON 文档" },
      { name: "path", desc: "JSON 路径" },
    ],
  ),
  fn("CURRENT_TIMESTAMP", "CURRENT_TIMESTAMP", "CURRENT_TIMESTAMP", "当前时间戳", "date", ["postgresql", "common"], [], "TIMESTAMP"),
  fn(
    "TO_CHAR",
    "TO_CHAR(value, format)",
    "TO_CHAR(${1:value}, ${2:'YYYY-MM-DD'})",
    "格式化输出",
    "date",
    ["postgresql"],
    [
      { name: "value", desc: "日期/数值" },
      { name: "format", desc: "格式模板" },
    ],
  ),
  fn(
    "TO_DATE",
    "TO_DATE(text, format)",
    "TO_DATE(${1:text}, ${2:'YYYY-MM-DD'})",
    "文本转日期",
    "date",
    ["postgresql"],
    [
      { name: "text", desc: "日期文本" },
      { name: "format", desc: "格式模板" },
    ],
  ),
  fn(
    "DATE_TRUNC",
    "DATE_TRUNC(field, source)",
    "DATE_TRUNC('${1:day}', ${2:timestamp})",
    "截断到指定精度",
    "date",
    ["postgresql"],
    [
      { name: "field", desc: "day / month / year …" },
      { name: "source", desc: "时间戳" },
    ],
  ),
  fn(
    "STRING_AGG",
    "STRING_AGG(expr, delimiter)",
    "STRING_AGG(${1:expr}, ${2:', '})",
    "聚合连接字符串",
    "aggregate",
    ["postgresql"],
    [
      { name: "expr", desc: "表达式" },
      { name: "delimiter", desc: "分隔符" },
    ],
  ),
  fn(
    "EXTRACT",
    "EXTRACT(field FROM source)",
    "EXTRACT(${1:YEAR} FROM ${2:timestamp})",
    "提取日期部分",
    "date",
    ["postgresql", "common"],
    [
      { name: "field", desc: "YEAR / MONTH / DAY …" },
      { name: "source", desc: "日期时间" },
    ],
  ),
  fn(
    "strftime",
    "strftime(format, timestring)",
    "strftime('${1:%Y-%m-%d}', ${2:column})",
    "SQLite 日期格式化",
    "date",
    ["sqlite"],
    [
      { name: "format", desc: "格式串" },
      { name: "timestring", desc: "时间列" },
    ],
  ),
  fn("ABS", "ABS(n)", "ABS(${1:n})", "绝对值", "math", ["common"], [{ name: "n", desc: "数值" }]),
  fn("ROUND", "ROUND(n, d)", "ROUND(${1:n}, ${2:0})", "四舍五入", "math", ["common"], [
    { name: "n", desc: "数值" },
    { name: "d", desc: "小数位", optional: true },
  ]),
  fn("ROW_NUMBER", "ROW_NUMBER() OVER (...)", "ROW_NUMBER() OVER (PARTITION BY ${1:col} ORDER BY ${2:col})", "行号", "window", ["common"], []),
  fn("RANK", "RANK() OVER (...)", "RANK() OVER (ORDER BY ${1:col})", "排名", "window", ["common"], []),
  fn("DENSE_RANK", "DENSE_RANK() OVER (...)", "DENSE_RANK() OVER (ORDER BY ${1:col})", "密集排名", "window", ["common"], []),
];

function normalizeEngine(dbType?: string | null): SqlFunctionDialectTag | "other" {
  const engine = (dbType ?? "").trim().toLowerCase();
  if (engine === "mysql" || engine === "mariadb") return "mysql";
  if (engine === "postgresql" || engine === "postgres") return "postgresql";
  if (engine === "sqlite") return "sqlite";
  return "other";
}

/** 按连接方言返回可用 SQL 函数列表。 */
export function getSqlFunctionsForDialect(dbType?: string | null): SqlFunctionDef[] {
  const engine = normalizeEngine(dbType);
  if (engine === "other") {
    return SQL_FUNCTION_CATALOG.filter((item) => item.dialects.includes("common"));
  }
  return SQL_FUNCTION_CATALOG.filter(
    (item) => item.dialects.includes("common") || item.dialects.includes(engine),
  );
}

export function findSqlFunctionDef(name: string, dbType?: string | null): SqlFunctionDef | undefined {
  const key = name.toUpperCase();
  return getSqlFunctionsForDialect(dbType).find((item) => item.name.toUpperCase() === key);
}

export type SqlFunctionCompletionContext =
  | "statement_start"
  | "select_list"
  | "from_clause"
  | "where_clause"
  | "group_by"
  | "order_by"
  | "insert_into"
  | "update_table"
  | "update_set"
  | "delete_from"
  | "general";

export function filterFunctionsForContext(
  functions: SqlFunctionDef[],
  context: SqlFunctionCompletionContext,
): SqlFunctionDef[] {
  if (context === "from_clause" || context === "insert_into" || context === "update_table" || context === "delete_from") {
    return [];
  }
  if (context === "group_by") {
    return functions.filter((item) => item.category === "aggregate" || item.category === "string" || item.category === "date");
  }
  if (context === "where_clause") {
    return functions.filter((item) => item.category !== "window");
  }
  if (context === "order_by" || context === "select_list") {
    return functions;
  }
  return functions.filter((item) => item.category !== "window");
}

const FUNCTION_KIND = 3;

export interface SqlFunctionCompletionItem {
  label: string;
  kind: number;
  insertText: string;
  detail?: string;
  snippet?: boolean;
  boost?: number;
  info?: string;
}

export function buildFunctionCompletionItems(
  dbType: string | null | undefined,
  context: SqlFunctionCompletionContext,
): SqlFunctionCompletionItem[] {
  const defs = filterFunctionsForContext(getSqlFunctionsForDialect(dbType), context);
  return defs.map((item) => ({
    label: item.name,
    kind: FUNCTION_KIND,
    insertText: item.insertSnippet,
    snippet: item.insertSnippet.includes("${"),
    detail: item.signature,
    boost: item.category === "aggregate" && (context === "select_list" || context === "group_by") ? 2 : 0,
    info: item.description,
  }));
}
