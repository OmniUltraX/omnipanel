import type { TableDesignerTypeOption } from "../types";
import { buildApplySqlSQLite } from "../applySql";
import {
  createEmptyField,
  createEmptyIndex,
  createGenericDriver,
  fromSchemaGeneric,
  validateGeneric,
} from "./genericDriver";

const SQLITE_TYPES: TableDesignerTypeOption[] = [
  { value: "INTEGER", label: "INTEGER" },
  { value: "TEXT", label: "TEXT" },
  { value: "REAL", label: "REAL" },
  { value: "BLOB", label: "BLOB" },
  { value: "NUMERIC", label: "NUMERIC" },
];

function sqliteQuoteId(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export const sqliteTableDesignerDriver = {
  ...createGenericDriver("sqlite", "SQLite"),
  createEmptyField: () => createEmptyField("INTEGER"),
  getTypeOptions: () => SQLITE_TYPES,
  createEmptyIndex,
  fromSchema: fromSchemaGeneric,
  validate: validateGeneric,
  buildPreviewSql(model, dbName) {
    const lines = model.fields.map((field) => {
      const parts = [`  ${sqliteQuoteId(field.name)} ${field.type.trim()}`];
      if (!field.nullable) parts.push("NOT NULL");
      if (field.isPk) parts.push("PRIMARY KEY");
      if (field.isAutoIncrement && field.type.trim().toUpperCase() === "INTEGER") {
        parts.push("AUTOINCREMENT");
      }
      if (field.defaultValue.trim()) parts.push(`DEFAULT ${field.defaultValue.trim()}`);
      return parts.join(" ");
    });
    for (const index of model.indexes) {
      if (index.primary || index.columns.length === 0) continue;
      const cols = index.columns.map((c) => sqliteQuoteId(c)).join(", ");
      const kind = index.unique ? "UNIQUE INDEX" : "INDEX";
      lines.push(
        `  ${kind} ${sqliteQuoteId(index.name || `idx_${index.columns.join("_")}`)} (${cols})`,
      );
    }
    return [
      `-- ${dbName} / ${model.tableName}`,
      model.comment.trim() ? `-- ${model.comment.trim()}` : "",
      `CREATE TABLE ${sqliteQuoteId(model.tableName)} (`,
      lines.join(",\n"),
      ");",
    ]
      .filter(Boolean)
      .join("\n");
  },
  buildApplySql: buildApplySqlSQLite,
};
