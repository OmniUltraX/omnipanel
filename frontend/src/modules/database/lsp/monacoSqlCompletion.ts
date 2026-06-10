import type { editor, languages, Position } from "monaco-editor";
import type { DatabaseSchema } from "../types";
import { buildTableActionSnippets, getCompletionItems } from "./sqlCompletion";
import type { TableSchema } from "../types";

type Monaco = typeof import("monaco-editor");

const SQL_NOISE_TOKENS = new Set([
  "SELECT", "FROM", "WHERE", "JOIN", "ON", "AND", "OR", "AS", "INTO", "SET",
  "VALUES", "UPDATE", "DELETE", "INSERT", "GROUP", "ORDER", "BY", "LIMIT",
  "HAVING", "LEFT", "RIGHT", "INNER", "OUTER", "CROSS", "UNION", "DISTINCT",
]);

type TableDotContext = {
  table: TableSchema;
  qualifiedTable: string;
  tableTokenInLine: string;
  /** 来自 `表.字段 运算符 值.` 时已输入的 WHERE 条件（如 `id > 0`） */
  whereClause?: string;
};

function completionRange(model: editor.ITextModel, position: Position) {
  const word = model.getWordUntilPosition(position);
  return {
    startLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endLineNumber: position.lineNumber,
    endColumn: word.endColumn,
  };
}

function prefixAfterLastDot(linePrefix: string): string {
  const dot = linePrefix.lastIndexOf(".");
  if (dot === -1) return "";
  return linePrefix.slice(dot + 1).match(/^(\w*)$/)?.[1] ?? "";
}

function filterByPrefix<T extends { label: string }>(items: T[], prefix: string): T[] {
  if (!prefix) return items;
  const key = prefix.toLowerCase();
  return items.filter((item) => item.label.toLowerCase().startsWith(key));
}

function textOffset(model: editor.ITextModel, position: Position): number {
  const lines = model.getValue().split("\n");
  let offset = 0;
  for (let i = 0; i < position.lineNumber - 1; i++) {
    offset += (lines[i]?.length ?? 0) + 1;
  }
  offset += position.column - 1;
  return offset;
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

/** 解析 `表.` / `库.表.` 上下文；表名优先于库名（避免 `库名.` 误占表片段）。 */
function resolveDirectTableDotContext(
  linePrefix: string,
  schemas: DatabaseSchema[],
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

/** 从 `表.字段 运算符 值[.]` 中提取 WHERE 条件文本（如 `id > 0`）。 */
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

/** 解析 `表.字段 运算符 值.` / `库.表.字段 运算符 值.` 后的表上下文。 */
function resolveTableConditionDotContext(
  linePrefix: string,
  schemas: DatabaseSchema[],
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
  schemas: DatabaseSchema[],
): TableDotContext | null {
  return (
    resolveTableConditionDotContext(linePrefix, schemas) ??
    resolveDirectTableDotContext(linePrefix, schemas)
  );
}

function columnSuggestions(
  monaco: Monaco,
  range: languages.CompletionItem["range"],
  tableName: string,
  columns: DatabaseSchema["tables"][number]["columns"],
): languages.CompletionItem[] {
  return columns.map((col) => ({
    label: col.name,
    kind: monaco.languages.CompletionItemKind.Field,
    detail: `${col.type}${col.isPK ? " (PK)" : ""}${col.isFK ? " (FK)" : ""} · ${tableName}`,
    insertText: col.name,
    filterText: col.name,
    range,
  }));
}

function tableSuggestions(
  monaco: Monaco,
  range: languages.CompletionItem["range"],
  database: DatabaseSchema,
): languages.CompletionItem[] {
  return database.tables.map((table) => ({
    label: table.name,
    kind: monaco.languages.CompletionItemKind.Struct,
    detail: `表 · ${database.name} (${table.columns.length} 列)`,
    insertText: table.name,
    filterText: table.name,
    range,
  }));
}

function tableDotSuggestions(
  monaco: Monaco,
  _model: editor.ITextModel,
  position: Position,
  linePrefix: string,
  ctx: TableDotContext,
): languages.CompletionItem[] {
  const dotIndex = linePrefix.lastIndexOf(".");
  const tableStartCol = linePrefix.indexOf(ctx.tableTokenInLine) + 1;
  const afterDotCol = dotIndex + 2;
  const filterRange = {
    startLineNumber: position.lineNumber,
    startColumn: afterDotCol,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  };
  const removeTablePrefixEdit: languages.CompletionItem["additionalTextEdits"] = [
    {
      range: {
        startLineNumber: position.lineNumber,
        startColumn: tableStartCol,
        endLineNumber: position.lineNumber,
        endColumn: afterDotCol,
      },
      text: "",
    },
  ];

  const prefix = prefixAfterLastDot(linePrefix);
  const actions = filterByPrefix(
    buildTableActionSnippets(ctx.qualifiedTable, ctx.table, ctx.whereClause),
    prefix,
  );

  const actionItems: languages.CompletionItem[] = actions.map((item) => {
    const suggestion: languages.CompletionItem = {
      label: item.label,
      kind: monaco.languages.CompletionItemKind.Snippet,
      detail: item.detail,
      insertText: item.insertText ?? item.label,
      filterText: item.label,
      range: filterRange,
      additionalTextEdits: removeTablePrefixEdit,
      sortText: `0_${item.label}`,
    };
    if (item.snippet) {
      suggestion.insertTextRules =
        monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
    }
    return suggestion;
  });

  const allColumns = columnSuggestions(
    monaco,
    filterRange,
    ctx.table.name,
    ctx.table.columns,
  );
  const columns = prefix
    ? allColumns.filter((col) =>
        String(col.filterText ?? col.label)
          .toLowerCase()
          .startsWith(prefix.toLowerCase()),
      )
    : allColumns;

  return [
    ...actionItems,
    ...columns.map((col) => ({ ...col, sortText: `1_${col.label}` })),
  ];
}

/** 根据当前库表元数据为 Monaco SQL 编辑器提供补全。 */
export function provideMonacoSqlCompletions(
  monaco: Monaco,
  schemas: DatabaseSchema[],
  model: editor.ITextModel,
  position: Position,
): languages.CompletionList {
  const range = completionRange(model, position);
  const linePrefix = model.getLineContent(position.lineNumber).substring(0, position.column - 1);

  const tableCtx = resolveTableDotContext(linePrefix, schemas);
  if (tableCtx) {
    const suggestions = tableDotSuggestions(monaco, model, position, linePrefix, tableCtx);
    return { suggestions: dedupeCompletionItems(suggestions) };
  }

  const singleDot = linePrefix.match(/(\w+)\.(\w*)$/);
  if (singleDot) {
    const token = singleDot[1];
    const asDatabase = findDatabase(schemas, token);
    if (asDatabase) {
      return {
        suggestions: dedupeCompletionItems(tableSuggestions(monaco, range, asDatabase)),
      };
    }
  }

  const offset = textOffset(model, position);
  const text = model.getValue();
  const items = getCompletionItems(text, offset, schemas);
  const suggestions: languages.CompletionItem[] = items.map((item) => {
    let kind = monaco.languages.CompletionItemKind.Text;
    if (item.kind === 14) {
      kind = monaco.languages.CompletionItemKind.Keyword;
    } else if (item.kind === 3) {
      kind = monaco.languages.CompletionItemKind.Function;
    } else if (item.kind === 5) {
      kind = monaco.languages.CompletionItemKind.Field;
    } else if (item.kind === 22) {
      kind = monaco.languages.CompletionItemKind.Struct;
    } else if (item.kind === 9) {
      kind = monaco.languages.CompletionItemKind.Module;
    }

    const suggestion: languages.CompletionItem = {
      label: item.label,
      kind,
      detail: item.detail,
      insertText: item.insertText ?? item.label,
      filterText: item.label,
      range,
    };
    if (item.snippet) {
      suggestion.insertTextRules =
        monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
    }
    return suggestion;
  });

  return { suggestions: dedupeCompletionItems(suggestions) };
}

const modelSchemaGetters = new WeakMap<
  editor.ITextModel,
  () => DatabaseSchema[]
>();
let sqlCompletionProviderRegistered = false;

export function bindEditorModelSchemas(
  model: editor.ITextModel,
  getSchemas: () => DatabaseSchema[],
): void {
  modelSchemaGetters.set(model, getSchemas);
}

export function unbindEditorModelSchemas(model: editor.ITextModel): void {
  modelSchemaGetters.delete(model);
}

function dedupeCompletionItems(
  items: languages.CompletionItem[],
): languages.CompletionItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${String(item.label)}\0${item.insertText ?? item.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 全局只注册一次；各编辑器实例通过 bindEditorModelSchemas 绑定 model → schemas。 */
export function ensureMonacoSqlCompletionProvider(monaco: Monaco): void {
  if (sqlCompletionProviderRegistered) return;
  sqlCompletionProviderRegistered = true;

  monaco.languages.registerCompletionItemProvider("sql", {
    triggerCharacters: [".", " ", "("],
    provideCompletionItems(model, position) {
      const getSchemas = modelSchemaGetters.get(model);
      if (!getSchemas) {
        return { suggestions: [] };
      }
      return provideMonacoSqlCompletions(monaco, getSchemas(), model, position);
    },
  });
}

/** @deprecated 使用 ensureMonacoSqlCompletionProvider + bindEditorModelSchemas */
export function registerMonacoSqlCompletionProvider(
  monaco: Monaco,
  getSchemas: () => DatabaseSchema[],
) {
  ensureMonacoSqlCompletionProvider(monaco);
  return {
    dispose() {
      /* 兼容旧调用；实际 provider 为单例 */
    },
    bindModel(model: editor.ITextModel) {
      bindEditorModelSchemas(model, getSchemas);
    },
  };
}
