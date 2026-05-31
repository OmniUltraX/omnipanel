import type { editor, languages, Position } from "monaco-editor";
import type { DatabaseSchema } from "../types";
import { getCompletionItems } from "./sqlCompletion";

type Monaco = typeof import("monaco-editor");

function completionRange(model: editor.ITextModel, position: Position) {
  const word = model.getWordUntilPosition(position);
  return {
    startLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endLineNumber: position.lineNumber,
    endColumn: word.endColumn,
  };
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
    range,
  }));
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

  const dbTableDot = linePrefix.match(/(\w+)\.(\w+)\.$/);
  if (dbTableDot) {
    const database = findDatabase(schemas, dbTableDot[1]);
    const table = findTable(database, dbTableDot[2]);
    if (table) {
      return { suggestions: columnSuggestions(monaco, range, table.name, table.columns) };
    }
  }

  const singleDot = linePrefix.match(/(\w+)\.$/);
  if (singleDot) {
    const token = singleDot[1];
    const asDatabase = findDatabase(schemas, token);
    if (asDatabase) {
      return { suggestions: tableSuggestions(monaco, range, asDatabase) };
    }
    for (const database of schemas) {
      const asTable = findTable(database, token);
      if (asTable) {
        return { suggestions: columnSuggestions(monaco, range, asTable.name, asTable.columns) };
      }
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
      range,
    };
    if (item.snippet) {
      suggestion.insertTextRules =
        monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
    }
    return suggestion;
  });

  return { suggestions };
}

export function registerMonacoSqlCompletionProvider(
  monaco: Monaco,
  getSchemas: () => DatabaseSchema[],
) {
  return monaco.languages.registerCompletionItemProvider("sql", {
    triggerCharacters: [".", " ", "("],
    provideCompletionItems(model, position) {
      return provideMonacoSqlCompletions(monaco, getSchemas(), model, position);
    },
  });
}
