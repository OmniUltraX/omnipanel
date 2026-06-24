import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  snippetCompletion,
} from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import type { DatabaseSchema, TableSchema } from "../types";
import { buildTableActionSnippets, getCompletionItems, resolveFromTableInStatement, resolveSqlCompletionContext } from "./sqlCompletion";

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

function filterByPrefix<T extends { label: string }>(items: T[], prefix: string): T[] {
  if (!prefix) return items;
  const key = prefix.toLowerCase();
  return items.filter((item) => item.label.toLowerCase().startsWith(key));
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

function completionKindToType(kind: number): string {
  if (kind === 14) return "keyword";
  if (kind === 3) return "function";
  if (kind === 5) return "property";
  if (kind === 22) return "class";
  if (kind === 9) return "namespace";
  return "text";
}

function columnSuggestions(
  tableName: string,
  columns: DatabaseSchema["tables"][number]["columns"],
): Completion[] {
  return columns.map((col) => ({
    label: col.name,
    type: "property",
    detail: `${col.type}${col.isPK ? " (PK)" : ""}${col.isFK ? " (FK)" : ""} · ${tableName}`,
    apply: col.name,
  }));
}

function tableSuggestions(database: DatabaseSchema): Completion[] {
  return database.tables.map((table) => ({
    label: table.name,
    type: "class",
    detail: `表 · ${database.name} (${table.columns.length} 列)`,
    apply: table.name,
  }));
}

function applyWithTablePrefixRemoval(
  view: EditorView,
  removeFrom: number,
  removeTo: number,
  insert: string,
  cursorPos: number,
) {
  view.dispatch({
    changes: { from: removeFrom, to: removeTo, insert },
    selection: { anchor: removeFrom + cursorPos },
  });
}

function tableDotSuggestions(
  context: CompletionContext,
  linePrefix: string,
  ctx: TableDotContext,
): CompletionResult {
  const line = context.state.doc.lineAt(context.pos);
  const dotIndex = linePrefix.lastIndexOf(".");
  const tableStartOffset = line.from + linePrefix.indexOf(ctx.tableTokenInLine);
  const afterDotOffset = line.from + dotIndex + 1;
  const replaceTo = context.pos;
  const prefix = prefixAfterLastDot(linePrefix);

  const actions = filterByPrefix(
    buildTableActionSnippets(ctx.qualifiedTable, ctx.table, ctx.whereClause),
    prefix,
  );

  const actionItems: Completion[] = actions.map((item) => {
    const insertText = item.insertText ?? item.label;
    const base = item.snippet
      ? snippetCompletion(insertText, {
          label: item.label,
          detail: item.detail,
          type: completionKindToType(item.kind),
          boost: 99,
        })
      : {
          label: item.label,
          type: completionKindToType(item.kind),
          detail: item.detail,
          boost: 99,
        };

    return {
      ...base,
      apply: (view: EditorView) => {
        applyWithTablePrefixRemoval(view, tableStartOffset, replaceTo, insertText, insertText.length);
      },
    };
  });

  const allColumns = columnSuggestions(ctx.table.name, ctx.table.columns);
  const columns = prefix
    ? allColumns.filter((col) => col.label.toLowerCase().startsWith(prefix.toLowerCase()))
    : allColumns;

  return {
    from: afterDotOffset,
    to: replaceTo,
    options: [
      ...actionItems,
      ...columns.map((col) => ({
        ...col,
        boost: 50,
        apply: (view: EditorView) => {
          applyWithTablePrefixRemoval(view, tableStartOffset, replaceTo, col.label, col.label.length);
        },
      })),
    ],
  };
}

function dedupeCompletions(items: Completion[]): Completion[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.label}\0${String(item.apply ?? item.label)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 根据当前库表元数据为 CodeMirror SQL 编辑器提供补全。 */
export function createSqlCompletionSource(
  getSchemas: () => DatabaseSchema[],
): (context: CompletionContext) => CompletionResult | null {
  return (context) => {
    const schemas = getSchemas();
    const line = context.state.doc.lineAt(context.pos);
    const linePrefix = line.text.slice(0, context.pos - line.from);

    const tableCtx = resolveTableDotContext(linePrefix, schemas);
    if (tableCtx) {
      return tableDotSuggestions(context, linePrefix, tableCtx);
    }

    const singleDot = linePrefix.match(/(\w+)\.(\w*)$/);
    if (singleDot) {
      const token = singleDot[1];
      const asDatabase = findDatabase(schemas, token);
      if (asDatabase) {
        const dotIndex = linePrefix.lastIndexOf(".");
        return {
          from: line.from + dotIndex + 1,
          to: context.pos,
          options: dedupeCompletions(tableSuggestions(asDatabase)),
        };
      }
    }

    const docText = context.state.doc.toString();
    const completionContext = resolveSqlCompletionContext(docText, context.pos);
    const hasSelectListColumnExpansion =
      completionContext === "select_list" &&
      resolveFromTableInStatement(docText, context.pos, schemas) !== null;

    const word = context.matchBefore(/\w*/);
    if (!word && !context.explicit && !hasSelectListColumnExpansion) {
      return null;
    }

    const from = word ? word.from : context.pos;
    const items = getCompletionItems(docText, context.pos, schemas);
    const options: Completion[] = items.map((item) => {
      const insertText = item.insertText ?? item.label;
      const boost = item.boost;
      if (item.snippet) {
        return snippetCompletion(insertText, {
          label: item.label,
          detail: item.detail,
          type: completionKindToType(item.kind),
          boost,
        });
      }
      return {
        label: item.label,
        type: completionKindToType(item.kind),
        detail: item.detail,
        apply: insertText,
        boost,
      };
    });

    return {
      from,
      to: context.pos,
      options: dedupeCompletions(options),
    };
  };
}
