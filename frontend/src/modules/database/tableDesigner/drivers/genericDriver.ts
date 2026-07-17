import type { DbTableSchema } from "../../api";
import {
  buildApplySqlMySQL,
  hasModelChanges as hasModelChangesShared,
} from "../applySql";
import {
  createDesignerRowId,
  type TableDesignerDriver,
  type TableDesignerFieldRow,
  type TableDesignerIndexRow,
  type TableDesignerModel,
  type TableDesignerTypeOption,
} from "../types";

const GENERIC_TYPES: TableDesignerTypeOption[] = [
  { value: "INTEGER", label: "INTEGER" },
  { value: "BIGINT", label: "BIGINT" },
  { value: "VARCHAR", label: "VARCHAR" },
  { value: "TEXT", label: "TEXT" },
  { value: "BOOLEAN", label: "BOOLEAN" },
  { value: "DECIMAL", label: "DECIMAL" },
  { value: "DATE", label: "DATE" },
  { value: "TIMESTAMP", label: "TIMESTAMP" },
  { value: "JSON", label: "JSON" },
];

export function createEmptyField(defaultType = "VARCHAR"): TableDesignerFieldRow {
  return {
    id: createDesignerRowId(),
    name: "",
    type: defaultType,
    length: "",
    nullable: true,
    isPk: false,
    isAutoIncrement: false,
    defaultValue: "",
    comment: "",
  };
}

export function createEmptyIndex(): TableDesignerIndexRow {
  return {
    id: createDesignerRowId(),
    name: "",
    columns: [],
    unique: false,
    primary: false,
  };
}

/** 新建表初始模型：空表名 + 一行空白字段，便于直接编辑。 */
export function createEmptyTableModel(
  createField: () => TableDesignerFieldRow = createEmptyField,
): TableDesignerModel {
  return {
    tableName: "",
    comment: "",
    fields: [createField()],
    indexes: [],
  };
}

export function fromSchemaGeneric(schema: DbTableSchema): TableDesignerModel {
  const pkNames = new Set(schema.columns.filter((col) => col.isPk).map((col) => col.name));
  return {
    tableName: schema.name,
    comment: schema.comment?.trim() ?? "",
    fields: schema.columns.map((col) => ({
      id: createDesignerRowId(),
      name: col.name,
      type: col.type,
      length: col.length != null ? String(col.length) : "",
      nullable: col.nullable ?? true,
      isPk: col.isPk,
      isAutoIncrement:
        col.isAutoIncrement ?? /auto_increment|serial|identity/i.test(col.type),
      defaultValue: col.defaultValue ?? "",
      comment: col.comment?.trim() ?? "",
    })),
    indexes: (schema.indexes ?? []).map((idx) => ({
      id: createDesignerRowId(),
      name: idx.name,
      columns: [...idx.columns],
      unique: idx.unique,
      primary: idx.name.toUpperCase() === "PRIMARY" || idx.columns.every((c) => pkNames.has(c)),
    })),
  };
}

export function validateGeneric(model: TableDesignerModel): string | null {
  if (!model.tableName.trim()) {
    return "tableNameRequired";
  }
  if (model.fields.length === 0) {
    return "fieldsRequired";
  }
  const names = new Set<string>();
  for (const field of model.fields) {
    const name = field.name.trim();
    if (!name) {
      return "fieldNameRequired";
    }
    if (names.has(name.toLowerCase())) {
      return "duplicateFieldName";
    }
    names.add(name.toLowerCase());
  }
  for (const index of model.indexes) {
    if (index.columns.length === 0) {
      continue;
    }
    for (const col of index.columns) {
      if (!names.has(col.toLowerCase())) {
        return "indexColumnMissing";
      }
    }
  }
  return null;
}

export function buildPreviewSqlGeneric(model: TableDesignerModel, dbName: string): string {
  const lines: string[] = [
    `-- ${dbName}.${model.tableName}`,
    model.comment.trim() ? `-- ${model.comment.trim()}` : "",
    "CREATE TABLE `" + model.tableName + "` (",
  ].filter(Boolean);

  const fieldLines = model.fields.map((field) => {
    const parts = [`  \`${field.name}\` ${field.type}`];
    if (field.length.trim()) {
      parts[0] += `(${field.length.trim()})`;
    }
    if (field.isPk) parts.push("PRIMARY KEY");
    if (!field.nullable) parts.push("NOT NULL");
    if (field.isAutoIncrement) parts.push("AUTO_INCREMENT");
    if (field.defaultValue.trim()) parts.push(`DEFAULT ${field.defaultValue.trim()}`);
    if (field.comment.trim()) parts.push(`COMMENT '${field.comment.replace(/'/g, "''")}'`);
    return parts.join(" ");
  });

  for (const index of model.indexes) {
    if (index.primary || index.columns.length === 0) continue;
    const cols = index.columns.map((c) => `\`${c}\``).join(", ");
    const kind = index.unique ? "UNIQUE INDEX" : "INDEX";
    fieldLines.push(`  ${kind} \`${index.name || cols.replace(/`/g, "")}\` (${cols})`);
  }

  lines.push(fieldLines.join(",\n"));
  lines.push(");");
  return lines.join("\n");
}

export function createGenericDriver(engine: string, displayName: string): TableDesignerDriver {
  return {
    engine,
    displayName,
    supportsTableDesign: true,
    createEmptyField: () => createEmptyField(),
    createEmptyIndex,
    getTypeOptions: () => GENERIC_TYPES,
    fromSchema: fromSchemaGeneric,
    validate: validateGeneric,
    buildPreviewSql: buildPreviewSqlGeneric,
    buildApplySql: buildApplySqlMySQL,
    hasModelChanges: hasModelChangesShared,
  };
}
