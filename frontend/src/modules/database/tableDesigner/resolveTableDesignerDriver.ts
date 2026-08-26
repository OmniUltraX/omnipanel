import type { DbConnectionConfig } from "../api";
import { connectionHasTableSchemaChildren } from "../api";
import { canonicalHostEngine, catalogFamily } from "../hostCapabilities";
import { mysqlTableDesignerDriver } from "./drivers/mysqlDriver";
import { postgresTableDesignerDriver } from "./drivers/postgresDriver";
import { sqliteTableDesignerDriver } from "./drivers/sqliteDriver";
import { sqlserverTableDesignerDriver } from "./drivers/sqlserverDriver";
import { oracleLikeTableDesignerDriver } from "./drivers/oracleLikeDriver";
import { createGenericDriver } from "./drivers/genericDriver";
import { buildApplySqlAnsi } from "./applySql";
import type { TableDesignerDriver } from "./types";

const UNSUPPORTED_DRIVER: TableDesignerDriver = {
  ...createGenericDriver("unsupported", "Unsupported"),
  supportsTableDesign: false,
  buildApplySql: () => [],
  hasModelChanges: () => false,
};

const ANSI_DRIVER: TableDesignerDriver = {
  ...createGenericDriver("ansi", "SQL"),
  buildPreviewSql(model, dbName) {
    const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
    const lines = model.fields.map((field) => {
      const type = field.length.trim() ? `${field.type}(${field.length.trim()})` : field.type;
      const parts = [`  ${quote(field.name)} ${type}`];
      if (field.isPk) parts.push("PRIMARY KEY");
      if (!field.nullable) parts.push("NOT NULL");
      if (field.defaultValue.trim()) parts.push(`DEFAULT ${field.defaultValue.trim()}`);
      return parts.join(" ");
    });
    for (const index of model.indexes) {
      if (index.primary || index.columns.length === 0) continue;
      const cols = index.columns.map((c) => quote(c)).join(", ");
      const kind = index.unique ? "UNIQUE" : "";
      lines.push(
        `  ${kind ? `${kind} ` : ""}INDEX ${quote(index.name || "idx_" + index.columns.join("_"))} (${cols})`.trim(),
      );
    }
    const tableRef = dbName.trim()
      ? `${quote(dbName.trim())}.${quote(model.tableName)}`
      : quote(model.tableName);
    return [
      `-- ${dbName}.${model.tableName}`,
      model.comment.trim() ? `-- ${model.comment.trim()}` : "",
      `CREATE TABLE ${tableRef} (`,
      lines.join(",\n"),
      ");",
    ]
      .filter(Boolean)
      .join("\n");
  },
  buildApplySql: buildApplySqlAnsi,
};

export function resolveTableDesignerDriver(
  connection: Pick<DbConnectionConfig, "db_type">,
): TableDesignerDriver {
  if (!connectionHasTableSchemaChildren(connection)) {
    return UNSUPPORTED_DRIVER;
  }

  const engine = canonicalHostEngine(connection.db_type);
  const family = catalogFamily(engine);
  if (engine === "mysql" || family === "mysqlLike") {
    return mysqlTableDesignerDriver;
  }
  if (engine === "postgres" || family === "postgresLike") {
    return postgresTableDesignerDriver;
  }
  if (engine === "sqlite") {
    return sqliteTableDesignerDriver;
  }
  if (engine === "sqlserver") {
    return sqlserverTableDesignerDriver;
  }
  if (family === "oracleLike") {
    return oracleLikeTableDesignerDriver;
  }
  if (family === "hiveLike" || family === "genericSql") {
    return ANSI_DRIVER;
  }
  return UNSUPPORTED_DRIVER;
}

export function supportsTableDesign(
  connection: Pick<DbConnectionConfig, "db_type">,
): boolean {
  return resolveTableDesignerDriver(connection).supportsTableDesign;
}
