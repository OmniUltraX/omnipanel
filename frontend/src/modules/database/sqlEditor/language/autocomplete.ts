import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  snippetCompletion,
  startCompletion,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { DatabaseSchema, TableSchema } from "../../types";
import { filterAndRankByFuzzy } from "../../../../lib/fuzzyMatch";
import {
  COLUMN_KIND,
  getCompletionItems,
  recordSqlCompletionUsage,
  shouldOfferColumnCompletionsWithoutPrefix,
  shouldOfferFromTableTailCompletions,
  shouldOfferTableCompletionsWithoutPrefix,
  tierBoostForKind,
} from "./completionItems";
import { getSqlCompletionUsageBoost } from "../../sqlIntel/sqlCompletionUsage";
import {
  resolveFromTableInStatement,
  resolveAliasTableInStatement,
  resolveSqlCompletionContext,
} from "../parser/context";
import { analyzeStatement } from "../parser/analyzer";
import { sliceStatementAtOffset } from "../parser/ast";
import { applySqlKeywordCase, type SqlKeywordCase } from "../../sqlIntel/sqlKeywordCase";
import {
  currentSqlWordPrefix,
  isCursorInSqlString,
} from "../../sqlIntel/sqlCompletionPosition";

const SQL_NOISE_TOKENS = new Set([
  "SELECT", "FROM", "WHERE", "JOIN", "ON", "AND", "OR", "AS", "INTO", "SET",
  "VALUES", "UPDATE", "DELETE", "INSERT", "GROUP", "ORDER", "BY", "LIMIT",
  "HAVING", "LEFT", "RIGHT", "INNER", "OUTER", "CROSS", "UNION", "DISTINCT",
]);

type TableDotContext = {
  table: TableSchema;
  qualifiedTable: string;
  tableTokenInLine: string;
  whereClause?: string;
};

function prefixAfterLastDot(linePrefix: string): string {
  const dot = linePrefix.lastIndexOf(".");
  if (dot === -1) return "";
  return linePrefix.slice(dot + 1).match(/^(\w*)$/)?.[1] ?? "";
}

function filterByFuzzy<T extends { label: string; boost?: number }>(items: T[], prefix: string): T[] {
  if (!prefix) return items;
  return filterAndRankByFuzzy(items, prefix);
}

function findDatabase(schemas: DatabaseSchema[], name: string): DatabaseSchema | undefined {
  const key = name.toLowerCase();
  return schemas.find((db) => db.name.toLowerCase() === key);
}

function findTable(database: DatabaseSchema | undefined, name: string) {
  if (!database) {
    return undefined;
  }
  const key = name.toLowerCase();
  return database.tables.find((table) => table.name.toLowerCase() === key);
}

function anySchemaHasTables(schemas: DatabaseSchema[]): boolean {
  return schemas.some((db) => db.tables.length > 0);
}

function resolveDirectTableDotContext(
  linePrefix: string,
  docText: string,
  docOffset: number,
  schemas: DatabaseSchema[],
  dbType?: string,
): TableDotContext | null {
  const dbTableDot = linePrefix.match(/(\w+)\.(\w+)\.(\w*)$/);
  if (dbTableDot) {
    const database = findDatabase(schemas, dbTableDot[1]);
    const table =
      findTable(database, dbTableDot[2]) ??
      (database && !anySchemaHasTables(schemas)
        ? { name: dbTableDot[2], columns: [] }
        : undefined);
    if (table && database) {
      return {
        table,
        qualifiedTable: `${database.name}.${table.name}`,
        tableTokenInLine: `${dbTableDot[1]}.${dbTableDot[2]}`,
      };
    }
  }

  const singleDot = linePrefix.match(/(\w+)\.(\w*)$/);
  if (!singleDot) {
    return null;
  }

  const token = singleDot[1];
  const partial = singleDot[2];

  const aliasResolved = resolveAliasTableInStatement(docText, docOffset, token, schemas, dbType);
  if (aliasResolved) {
    return {
      table: aliasResolved.table,
      qualifiedTable: aliasResolved.qualifiedTable,
      tableTokenInLine: token,
    };
  }

  if (/^\d+$/.test(token)) {
    return null;
  }

  for (const database of schemas) {
    const table = findTable(database, token);
    if (table) {
      return {
        table,
        qualifiedTable: table.name,
        tableTokenInLine: token,
      };
    }
  }

  if (
    partial === "" &&
    !findDatabase(schemas, token) &&
    !SQL_NOISE_TOKENS.has(token.toUpperCase()) &&
    !anySchemaHasTables(schemas)
  ) {
    return {
      table: { name: token, columns: [] },
      qualifiedTable: token,
      tableTokenInLine: token,
    };
  }

  return null;
}

const SQL_VALUE_PATTERN =
  "(?:'(?:[^'\\\\]|\\\\.)*'|\"(?:[^\"\\\\]|\\\\.)*\"|\\d+(?:\\.\\d+)?|NULL|\\w+)";
const SQL_COMPARE_OP_PATTERN = "(?:<>|!=|<=|>=|=|<|>|(?:NOT\\s+)?LIKE)";
const SQL_CONDITION_TAIL_PATTERN = `(?:${SQL_COMPARE_OP_PATTERN}\\s*${SQL_VALUE_PATTERN}?|IS\\s+(?:NOT\\s+)?NULL)`;

function lookupTableContext(
  schemas: DatabaseSchema[],
  databaseName: string | undefined,
  tableName: string,
  tableTokenInLine: string,
): TableDotContext | null {
  if (databaseName) {
    const database = findDatabase(schemas, databaseName);
    const table =
      findTable(database, tableName) ??
      (database && !anySchemaHasTables(schemas)
        ? { name: tableName, columns: [] }
        : undefined);
    if (table && database) {
      return {
        table,
        qualifiedTable: `${database.name}.${table.name}`,
        tableTokenInLine,
      };
    }
    return null;
  }

  for (const database of schemas) {
    const table = findTable(database, tableName);
    if (table) {
      return {
        table,
        qualifiedTable: table.name,
        tableTokenInLine,
      };
    }
  }

  if (
    !findDatabase(schemas, tableName) &&
    !SQL_NOISE_TOKENS.has(tableName.toUpperCase()) &&
    !anySchemaHasTables(schemas)
  ) {
    return {
      table: { name: tableName, columns: [] },
      qualifiedTable: tableName,
      tableTokenInLine,
    };
  }

  return null;
}

function columnBelongsToTable(table: TableSchema, columnName: string): boolean {
  if (table.columns.length === 0) {
    return true;
  }
  const key = columnName.toLowerCase();
  return table.columns.some((col) => col.name.toLowerCase() === key);
}

function parseWhereClauseAfterTable(
  linePrefix: string,
  tableTokenInLine: string,
): string | undefined {
  const pos = linePrefix.lastIndexOf(tableTokenInLine);
  if (pos < 0) return undefined;
  const afterTable = linePrefix.slice(pos + tableTokenInLine.length);
  const match = afterTable.match(
    new RegExp(
      `^\\.(\\w+)\\s*(${SQL_COMPARE_OP_PATTERN}\\s*${SQL_VALUE_PATTERN}?|IS\\s+(?:NOT\\s+)?NULL)(?:\\.(\\w*))?$`,
      "i",
    ),
  );
  if (!match) return undefined;
  return `${match[1]} ${match[2].trim()}`;
}

function withWhereClause(ctx: TableDotContext, linePrefix: string): TableDotContext {
  const whereClause = parseWhereClauseAfterTable(linePrefix, ctx.tableTokenInLine);
  if (!whereClause) return ctx;
  return { ...ctx, whereClause };
}

function resolveTableConditionDotContext(
  linePrefix: string,
  docText: string,
  docOffset: number,
  schemas: DatabaseSchema[],
  dbType?: string,
): TableDotContext | null {
  const dbTableColMatch = linePrefix.match(
    new RegExp(
      `(\\w+)\\.(\\w+)\\.(\\w+)\\s*${SQL_CONDITION_TAIL_PATTERN}\\.(\\w*)$`,
      "i",
    ),
  );
  if (dbTableColMatch) {
    const [, dbName, tableName, columnName] = dbTableColMatch;
    const ctx = lookupTableContext(
      schemas,
      dbName,
      tableName,
      `${dbName}.${tableName}`,
    );
    if (ctx && columnBelongsToTable(ctx.table, columnName)) {
      return withWhereClause(ctx, linePrefix);
    }
  }

  const tableColMatch = linePrefix.match(
    new RegExp(
      `(\\w+)\\.(\\w+)\\s*${SQL_CONDITION_TAIL_PATTERN}\\.(\\w*)$`,
      "i",
    ),
  );
  if (!tableColMatch) {
    return null;
  }

  const [, tableName, columnName] = tableColMatch;

  const aliasResolved = resolveAliasTableInStatement(docText, docOffset, tableName, schemas, dbType);
  if (aliasResolved && columnBelongsToTable(aliasResolved.table, columnName)) {
    return withWhereClause(
      {
        table: aliasResolved.table,
        qualifiedTable: aliasResolved.qualifiedTable,
        tableTokenInLine: tableName,
      },
      linePrefix,
    );
  }

  const trailingDotMatch = linePrefix.match(/(\w+)\.(\w*)$/);
  if (trailingDotMatch) {
    const trailingQualifier = trailingDotMatch[1];
    const rhsMatch = linePrefix.match(
      new RegExp(
        `(\\w+)\\.(\\w+)\\s*${SQL_COMPARE_OP_PATTERN}\\s*(\\w+)\\s*\\.\\s*\\w*$`,
        "i",
      ),
    );
    if (
      rhsMatch &&
      rhsMatch[1].toLowerCase() === tableName.toLowerCase() &&
      rhsMatch[2].toLowerCase() === columnName.toLowerCase() &&
      rhsMatch[3].toLowerCase() === trailingQualifier.toLowerCase()
    ) {
      return null;
    }
  }

  const asDatabase = findDatabase(schemas, tableName);
  if (asDatabase && findTable(asDatabase, columnName)) {
    return null;
  }

  const ctx = lookupTableContext(schemas, undefined, tableName, tableName);
  if (ctx && columnBelongsToTable(ctx.table, columnName)) {
    return withWhereClause(ctx, linePrefix);
  }

  return null;
}

function resolveTableDotContext(
  linePrefix: string,
  docText: string,
  docOffset: number,
  schemas: DatabaseSchema[],
  dbType?: string,
): TableDotContext | null {
  // 优先识别行尾的 `表/别名.字段`（如 ON tcn.id = tcfv.node），
  // 避免 `tcn.id = tcfv.node` 被误判为「条件表达式后的点号」上下文。
  return (
    resolveDirectTableDotContext(linePrefix, docText, docOffset, schemas, dbType) ??
    resolveTableConditionDotContext(linePrefix, docText, docOffset, schemas, dbType)
  );
}

function completionKindToType(kind: number): string {
  if (kind === 14) return "keyword";
  if (kind === 3) return "function";
  if (kind === 5) return "property";
  if (kind === 22) return "class";
  if (kind === 9) return "namespace";
  return "text";
}

function attachCompletionUsageTracking(
  option: Completion,
  kind: number,
  label: string,
): Completion {
  const originalApply = option.apply;
  if (typeof originalApply === "function") {
    return {
      ...option,
      apply(view, completion, from, to) {
        recordSqlCompletionUsage(kind, label);
        originalApply(view, completion, from, to);
      },
    };
  }
  return {
    ...option,
    apply(view, completion, from, to) {
      recordSqlCompletionUsage(kind, label);
      const insert = typeof originalApply === "string" ? originalApply : completion.label;
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
      });
    },
  };
}

function columnSuggestions(
  tableName: string,
  tableTokenInLine: string,
  columns: DatabaseSchema["tables"][number]["columns"],
): Completion[] {
  return columns.map((col) => ({
    label: col.name,
    type: "property",
    detail: `${col.type}${col.isPK ? " (PK)" : ""}${col.isFK ? " (FK)" : ""} · ${tableName}`,
    apply: `${tableTokenInLine}.${col.name}`,
  }));
}

function mapCompletionItemToOption(
  item: {
    label: string;
    kind: number;
    insertText?: string;
    detail?: string;
    snippet?: boolean;
    boost?: number;
    info?: string;
  },
  insertText: string,
  boostAdjust = 0,
): Completion {
  const boost = (item.boost ?? 0) + boostAdjust;
  const info = item.info;
  if (item.snippet) {
    return attachCompletionUsageTracking(
      snippetCompletion(insertText, {
        label: item.label,
        detail: item.detail,
        type: completionKindToType(item.kind),
        boost,
        info,
      }),
      item.kind,
      item.label,
    );
  }
  return attachCompletionUsageTracking(
    {
      label: item.label,
      type: completionKindToType(item.kind),
      detail: item.detail,
      apply: insertText,
      boost,
      info,
    },
    item.kind,
    item.label,
  );
}

function tableSuggestions(database: DatabaseSchema): Completion[] {
  return database.tables.map((table) => ({
    label: table.name,
    type: "class",
    detail: `表 · ${database.name} (${table.columns.length} 列)`,
    apply: table.name,
  }));
}

function resolveQualifierColumnRange(
  line: { from: number },
  linePrefix: string,
  pos: number,
): { qualifier: string; from: number; to: number } | null {
  const match = linePrefix.match(/(\w+)\.(\w*)$/);
  if (!match) return null;
  const dotIndex = linePrefix.lastIndexOf(".");
  return {
    qualifier: match[1],
    from: line.from + dotIndex + 1,
    to: pos,
  };
}

function bareColumnInsertText(insertText: string): string {
  if (!insertText.includes(".")) return insertText;
  return insertText.split(".").pop() ?? insertText;
}

function tableDotSuggestions(
  context: CompletionContext,
  linePrefix: string,
  ctx: TableDotContext,
): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos);
  const tokenOffset = linePrefix.lastIndexOf(ctx.tableTokenInLine);
  if (tokenOffset < 0) return null;
  const tableStartOffset = line.from + tokenOffset;
  const replaceTo = context.pos;
  const prefix = prefixAfterLastDot(linePrefix);

  const allColumns = columnSuggestions(ctx.table.name, ctx.tableTokenInLine, ctx.table.columns);
  const columns = prefix ? filterByFuzzy(allColumns, prefix) : allColumns;

  const options = columns.map((col) =>
    attachCompletionUsageTracking(
      {
        ...col,
        boost: tierBoostForKind(COLUMN_KIND) + getSqlCompletionUsageBoost(COLUMN_KIND, col.label),
      },
      COLUMN_KIND,
      col.label,
    ),
  );
  if (options.length === 0) return null;

  return {
    from: tableStartOffset,
    to: replaceTo,
    options,
  };
}

function dedupeCompletions(items: Completion[]): Completion[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.label}\0${item.detail ?? ""}\0${String(item.apply ?? item.label)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 补全已在 source 内做模糊过滤；同步 update 供退格/继续输入时刷新，filter:false 避免 CM 二次前缀过滤。 */
function withLiveCompletionUpdate(
  build: (context: CompletionContext) => CompletionResult | null,
  context: CompletionContext,
): CompletionResult | null {
  const result = build(context);
  if (!result || result.options.length === 0) return null;

  const update: NonNullable<CompletionResult["update"]> = (_current, _from, _to, ctx) => {
    const next = build(ctx);
    if (!next || next.options.length === 0) return null;
    return { ...next, from: next.from, to: ctx.pos, filter: false, update };
  };

  return { ...result, filter: false, update };
}

function shouldOfferSqlCompletion(state: EditorState): boolean {
  const pos = state.selection.main.head;
  const docText = state.doc.toString();
  if (isCursorInSqlString(docText, pos)) {
    return false;
  }
  const line = state.doc.lineAt(pos);
  const linePrefix = line.text.slice(0, pos - line.from);
  if (/^\s*$/.test(linePrefix)) return true;
  if (/\w+\.\w*$/.test(linePrefix)) return true;
  const prefix = currentSqlWordPrefix(docText, pos);
  return prefix.length > 0;
}

/** 无匹配导致补全关闭后，退格删除字符时重新触发补全查询。 */
export function sqlCompletionReopenOnDelete(): Extension {
  return EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    const deleted = update.transactions.some((tr) => {
      const event = tr.annotation(Transaction.userEvent);
      return typeof event === "string" && event.startsWith("delete.");
    });
    if (!deleted || !shouldOfferSqlCompletion(update.state)) return;
    startCompletion(update.view);
  });
}

/** FROM / WHERE 等子句后输入空格时自动弹出表名或字段补全。 */
export function sqlCompletionTriggerAfterClause(
  getSchemas: () => DatabaseSchema[],
  getDbType?: () => string | undefined,
): Extension {
  return EditorView.inputHandler.of((view, _from, to, text) => {
    if (text !== " ") return false;
    const docText = view.state.doc.toString();
    const context = resolveSqlCompletionContext(docText, to);
    const schemas = getSchemas();
    const dbType = getDbType?.();
    const fromTable = resolveFromTableInStatement(docText, to, schemas, dbType);
    const statement = sliceStatementAtOffset(docText, to).trim();
    const analysis = statement ? analyzeStatement(statement, dbType) : null;
    const hasScopedTables = fromTable !== null || (analysis?.tables.length ?? 0) > 0;
    const line = view.state.doc.lineAt(to);
    const linePrefix = line.text.slice(0, to - line.from);
    if (
      shouldOfferTableCompletionsWithoutPrefix(context) ||
      shouldOfferColumnCompletionsWithoutPrefix(context, hasScopedTables) ||
      shouldOfferFromTableTailCompletions(context, linePrefix, schemas)
    ) {
      requestAnimationFrame(() => startCompletion(view));
    }
    return false;
  });
}

function computeSqlCompletionResult(
  context: CompletionContext,
  getSchemas: () => DatabaseSchema[],
  getDbType?: () => string | undefined,
  getKeywordCase?: () => SqlKeywordCase,
): CompletionResult | null {
  const schemas = getSchemas();
  const dbType = getDbType?.();
  const keywordCase = getKeywordCase?.() ?? "upper";
  const docText = context.state.doc.toString();
  const line = context.state.doc.lineAt(context.pos);
  const linePrefix = line.text.slice(0, context.pos - line.from);

  const tableCtx = resolveTableDotContext(linePrefix, docText, context.pos, schemas, dbType);
  if (tableCtx) {
    return tableDotSuggestions(context, linePrefix, tableCtx);
  }

  const singleDot = linePrefix.match(/(\w+)\.(\w*)$/);
  if (singleDot) {
    const token = singleDot[1];
    const asDatabase = findDatabase(schemas, token);
    if (asDatabase) {
      const dotIndex = linePrefix.lastIndexOf(".");
      const options = dedupeCompletions(
        tableSuggestions(asDatabase).map((item) =>
          attachCompletionUsageTracking(
            {
              ...item,
              boost: tierBoostForKind(22),
            },
            22,
            item.label,
          ),
        ),
      );
      if (options.length === 0) return null;
      return {
        from: line.from + dotIndex + 1,
        to: context.pos,
        options,
      };
    }
  }

  const completionContext = resolveSqlCompletionContext(docText, context.pos);
  const statement = sliceStatementAtOffset(docText, context.pos).trim();
  const statementAnalysis = statement ? analyzeStatement(statement, dbType) : null;
  const fromTableInStmt = resolveFromTableInStatement(docText, context.pos, schemas, dbType);
  const hasScopedTables =
    fromTableInStmt !== null || (statementAnalysis?.tables.length ?? 0) > 0;
  const atLineContentStart = /^\s*$/.test(linePrefix);
  const hasSchemaTables = schemas.some((db) => db.tables.length > 0);
  const wantsStatementStartKeywords =
    completionContext === "statement_start" && atLineContentStart;
  const wantsTableNameContext =
    hasSchemaTables && shouldOfferTableCompletionsWithoutPrefix(completionContext);
  const wantsClauseColumns = shouldOfferColumnCompletionsWithoutPrefix(
    completionContext,
    hasScopedTables,
  );
  const wantsFromTableTail = shouldOfferFromTableTailCompletions(
    completionContext,
    linePrefix,
    schemas,
  );

  const qualCol = resolveQualifierColumnRange(line, linePrefix, context.pos);
  const qualStart =
    qualCol != null ? line.from + linePrefix.lastIndexOf(qualCol.qualifier) : null;

  const word = context.matchBefore(/\w*/);
  if (
    !word?.text &&
    !context.explicit &&
    !wantsStatementStartKeywords &&
    !wantsTableNameContext &&
    !wantsClauseColumns &&
    !wantsFromTableTail &&
    !qualCol
  ) {
    return null;
  }

  const from = qualStart ?? qualCol?.from ?? (word ? word.from : context.pos);
  const items = getCompletionItems(docText, context.pos, schemas, dbType, keywordCase);
  const options: Completion[] = items.map((item) => {
    let insertText = item.insertText ?? item.label;
    if (qualCol && item.kind === COLUMN_KIND) {
      const columnName = bareColumnInsertText(insertText);
      insertText = `${qualCol.qualifier}.${columnName}`;
    }
    return mapCompletionItemToOption(item, insertText);
  });

  const deduped = dedupeCompletions(options);
  if (deduped.length === 0) return null;

  return {
    from,
    to: context.pos,
    options: deduped,
  };
}

/** 根据当前库表元数据为 CodeMirror SQL 编辑器提供补全。 */
export function createSqlCompletionSource(
  getSchemas: () => DatabaseSchema[],
  getDbType?: () => string | undefined,
  getKeywordCase?: () => SqlKeywordCase,
): (context: CompletionContext) => CompletionResult | null {
  const build = (context: CompletionContext) =>
    computeSqlCompletionResult(context, getSchemas, getDbType, getKeywordCase);
  return (context) => withLiveCompletionUpdate(build, context);
}
