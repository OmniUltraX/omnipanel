import type {
  TableDesignerFieldRow,
  TableDesignerIndexRow,
  TableDesignerModel,
} from "./types";

function fieldSignature(field: TableDesignerFieldRow): string {
  return JSON.stringify({
    name: field.name.trim(),
    type: field.type.trim(),
    length: field.length.trim(),
    nullable: field.nullable,
    isPk: field.isPk,
    isAutoIncrement: field.isAutoIncrement,
    defaultValue: field.defaultValue.trim(),
    comment: field.comment.trim(),
  });
}

function indexSignature(index: TableDesignerIndexRow): string {
  return JSON.stringify({
    name: index.name.trim(),
    columns: index.columns.map((c) => c.trim()).filter(Boolean),
    unique: index.unique,
    primary: index.primary,
  });
}

function fieldOrderChanged(baseline: TableDesignerModel, model: TableDesignerModel): boolean {
  const baseOrder = baseline.fields.map((field) => field.id);
  const modelOrder = model.fields.map((field) => field.id);
  if (baseOrder.length !== modelOrder.length) return false;
  return baseOrder.some((id, index) => id !== modelOrder[index]);
}

function columnOrderNeedsApply(baseline: TableDesignerModel, model: TableDesignerModel): boolean {
  const removedIds = new Set(
    baseline.fields.filter((field) => !model.fields.some((item) => item.id === field.id)).map((field) => field.id),
  );
  const keptBaseOrder = baseline.fields
    .filter((field) => !removedIds.has(field.id))
    .map((field) => field.id);
  const newIds = model.fields
    .filter((field) => !baseline.fields.some((item) => item.id === field.id))
    .map((field) => field.id);
  const dbOrderAfterAlters = [...keptBaseOrder, ...newIds];
  const targetOrder = model.fields.map((field) => field.id);
  if (dbOrderAfterAlters.length !== targetOrder.length) return true;
  return dbOrderAfterAlters.some((id, index) => id !== targetOrder[index]);
}

function buildMysqlColumnReorderStmts(
  tableRef: string,
  targetFields: TableDesignerFieldRow[],
  initialOrder: string[],
): string[] {
  if (targetFields.length <= 1) return [];

  const fieldById = new Map(targetFields.map((field) => [field.id, field]));
  const stmts: string[] = [];
  let order = [...initialOrder];

  for (let index = 0; index < targetFields.length; index += 1) {
    const wantId = targetFields[index].id;
    const currentIndex = order.indexOf(wantId);
    if (currentIndex === index) continue;

    const field = fieldById.get(wantId);
    if (!field) continue;

    const definition = mysqlColumnDef(field);
    if (index === 0) {
      stmts.push(`ALTER TABLE ${tableRef} MODIFY COLUMN ${definition} FIRST`);
    } else {
      const afterName = targetFields[index - 1].name.trim();
      stmts.push(`ALTER TABLE ${tableRef} MODIFY COLUMN ${definition} AFTER ${mysqlQuoteId(afterName)}`);
    }

    order = order.filter((id) => id !== wantId);
    order.splice(index, 0, wantId);
  }

  return stmts;
}

function mysqlColumnOrderAfterAlters(baseline: TableDesignerModel, model: TableDesignerModel): string[] {
  const removedIds = new Set(
    baseline.fields.filter((field) => !model.fields.some((item) => item.id === field.id)).map((field) => field.id),
  );
  const keptBaseOrder = baseline.fields
    .filter((field) => !removedIds.has(field.id))
    .map((field) => field.id);
  const newIds = model.fields
    .filter((field) => !baseline.fields.some((item) => item.id === field.id))
    .map((field) => field.id);
  return [...keptBaseOrder, ...newIds];
}

export function hasModelChanges(
  baseline: TableDesignerModel,
  model: TableDesignerModel,
): boolean {
  if (baseline.tableName.trim() !== model.tableName.trim()) return true;
  if (baseline.comment.trim() !== model.comment.trim()) return true;

  const baseFields = new Map(baseline.fields.map((f) => [f.id, f]));
  const curFields = new Map(model.fields.map((f) => [f.id, f]));
  if (baseFields.size !== curFields.size) return true;
  for (const [id, field] of baseFields) {
    const cur = curFields.get(id);
    if (!cur || fieldSignature(field) !== fieldSignature(cur)) return true;
  }
  if (fieldOrderChanged(baseline, model)) return true;

  const baseIndexes = baseline.indexes.filter((i) => !i.primary);
  const curIndexes = model.indexes.filter((i) => !i.primary);
  if (baseIndexes.length !== curIndexes.length) return true;
  const baseIdx = new Map(baseIndexes.map((i) => [i.id, i]));
  for (const index of curIndexes) {
    const base = baseIdx.get(index.id);
    if (!base || indexSignature(base) !== indexSignature(index)) return true;
  }
  return false;
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function mysqlQuoteId(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

function mysqlColumnDef(field: TableDesignerFieldRow): string {
  let def = `${mysqlQuoteId(field.name.trim())} ${field.type.trim()}`;
  if (field.length.trim()) {
    def += `(${field.length.trim()})`;
  }
  if (!field.nullable) def += " NOT NULL";
  if (field.isAutoIncrement) def += " AUTO_INCREMENT";
  if (field.defaultValue.trim()) def += ` DEFAULT ${field.defaultValue.trim()}`;
  if (field.comment.trim()) {
    def += ` COMMENT '${escapeSqlString(field.comment.trim())}'`;
  }
  return def;
}

export function buildApplySqlMySQL(
  baseline: TableDesignerModel,
  model: TableDesignerModel,
  dbName: string,
): string[] {
  const stmts: string[] = [];
  const db = dbName.trim();
  const tableName = model.tableName.trim();
  const baseTableName = baseline.tableName.trim();
  const tableRef = `${mysqlQuoteId(db)}.${mysqlQuoteId(tableName)}`;

  if (baseTableName && tableName && baseTableName !== tableName) {
    stmts.push(
      `ALTER TABLE ${mysqlQuoteId(db)}.${mysqlQuoteId(baseTableName)} RENAME TO ${mysqlQuoteId(tableName)}`,
    );
  }

  if (baseline.comment.trim() !== model.comment.trim()) {
    stmts.push(
      `ALTER TABLE ${tableRef} COMMENT = '${escapeSqlString(model.comment.trim())}'`,
    );
  }

  const baseFields = new Map(baseline.fields.map((f) => [f.id, f]));
  const curFields = new Map(model.fields.map((f) => [f.id, f]));

  for (const field of baseFields.values()) {
    if (!curFields.has(field.id)) {
      stmts.push(`ALTER TABLE ${tableRef} DROP COLUMN ${mysqlQuoteId(field.name.trim())}`);
    }
  }

  for (const field of curFields.values()) {
    if (!baseFields.has(field.id)) {
      stmts.push(`ALTER TABLE ${tableRef} ADD COLUMN ${mysqlColumnDef(field)}`);
    }
  }

  for (const field of curFields.values()) {
    const base = baseFields.get(field.id);
    if (!base || fieldSignature(base) === fieldSignature(field)) continue;
    if (base.name.trim() !== field.name.trim()) {
      stmts.push(
        `ALTER TABLE ${tableRef} CHANGE COLUMN ${mysqlQuoteId(base.name.trim())} ${mysqlColumnDef(field)}`,
      );
    } else {
      stmts.push(`ALTER TABLE ${tableRef} MODIFY COLUMN ${mysqlColumnDef(field)}`);
    }
  }

  const baseIdx = new Map(
    baseline.indexes.filter((i) => !i.primary && i.columns.length > 0).map((i) => [i.id, i]),
  );
  const curIdx = new Map(
    model.indexes.filter((i) => !i.primary && i.columns.length > 0).map((i) => [i.id, i]),
  );

  for (const index of baseIdx.values()) {
    const cur = curIdx.get(index.id);
    if (!cur || indexSignature(index) !== indexSignature(cur)) {
      const name = index.name.trim() || index.columns.join("_");
      stmts.push(`ALTER TABLE ${tableRef} DROP INDEX ${mysqlQuoteId(name)}`);
    }
  }

  for (const index of curIdx.values()) {
    const base = baseIdx.get(index.id);
    if (base && indexSignature(base) === indexSignature(index)) continue;
    const cols = index.columns.map((c) => mysqlQuoteId(c.trim())).join(", ");
    const name = mysqlQuoteId(index.name.trim() || `idx_${index.columns.join("_")}`);
    if (index.unique) {
      stmts.push(`ALTER TABLE ${tableRef} ADD UNIQUE INDEX ${name} (${cols})`);
    } else {
      stmts.push(`ALTER TABLE ${tableRef} ADD INDEX ${name} (${cols})`);
    }
  }

  if (columnOrderNeedsApply(baseline, model)) {
    stmts.push(
      ...buildMysqlColumnReorderStmts(
        tableRef,
        model.fields,
        mysqlColumnOrderAfterAlters(baseline, model),
      ),
    );
  }

  return stmts;
}

function pgQuoteId(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function pgColumnDef(field: TableDesignerFieldRow): string {
  let def = field.type.trim();
  if (field.length.trim() && /varchar|char|numeric/i.test(def)) {
    def += `(${field.length.trim()})`;
  }
  if (!field.nullable) def += " NOT NULL";
  if (field.defaultValue.trim()) def += ` DEFAULT ${field.defaultValue.trim()}`;
  return def;
}

export function buildApplySqlPostgres(
  baseline: TableDesignerModel,
  model: TableDesignerModel,
  _dbName: string,
): string[] {
  const stmts: string[] = [];
  const schema = "public";
  const tableName = model.tableName.trim();
  const baseTableName = baseline.tableName.trim();
  const tableRef = `${pgQuoteId(schema)}.${pgQuoteId(tableName || baseTableName)}`;

  if (baseTableName && tableName && baseTableName !== tableName) {
    stmts.push(
      `ALTER TABLE ${pgQuoteId(schema)}.${pgQuoteId(baseTableName)} RENAME TO ${pgQuoteId(tableName)}`,
    );
  }

  const baseFields = new Map(baseline.fields.map((f) => [f.id, f]));
  const curFields = new Map(model.fields.map((f) => [f.id, f]));

  for (const field of baseFields.values()) {
    if (!curFields.has(field.id)) {
      stmts.push(
        `ALTER TABLE ${tableRef} DROP COLUMN ${pgQuoteId(field.name.trim())}`,
      );
    }
  }

  for (const field of curFields.values()) {
    if (!baseFields.has(field.id)) {
      stmts.push(
        `ALTER TABLE ${tableRef} ADD COLUMN ${pgQuoteId(field.name.trim())} ${pgColumnDef(field)}`,
      );
    }
  }

  for (const field of curFields.values()) {
    const base = baseFields.get(field.id);
    if (!base || fieldSignature(base) === fieldSignature(field)) continue;
    if (base.name.trim() !== field.name.trim()) {
      stmts.push(
        `ALTER TABLE ${tableRef} RENAME COLUMN ${pgQuoteId(base.name.trim())} TO ${pgQuoteId(field.name.trim())}`,
      );
    }
    if (
      base.type.trim() !== field.type.trim() ||
      base.length.trim() !== field.length.trim() ||
      base.nullable !== field.nullable ||
      base.defaultValue.trim() !== field.defaultValue.trim()
    ) {
      stmts.push(
        `ALTER TABLE ${tableRef} ALTER COLUMN ${pgQuoteId(field.name.trim())} TYPE ${pgColumnDef(field).split(" ").slice(1).join(" ") || field.type.trim()}`,
      );
    }
    if (base.nullable !== field.nullable) {
      stmts.push(
        `ALTER TABLE ${tableRef} ALTER COLUMN ${pgQuoteId(field.name.trim())} ${field.nullable ? "DROP NOT NULL" : "SET NOT NULL"}`,
      );
    }
    if (base.defaultValue.trim() !== field.defaultValue.trim()) {
      if (field.defaultValue.trim()) {
        stmts.push(
          `ALTER TABLE ${tableRef} ALTER COLUMN ${pgQuoteId(field.name.trim())} SET DEFAULT ${field.defaultValue.trim()}`,
        );
      } else {
        stmts.push(
          `ALTER TABLE ${tableRef} ALTER COLUMN ${pgQuoteId(field.name.trim())} DROP DEFAULT`,
        );
      }
    }
  }

  if (baseline.comment.trim() !== model.comment.trim()) {
    stmts.push(
      `COMMENT ON TABLE ${tableRef} IS '${escapeSqlString(model.comment.trim())}'`,
    );
  }

  const baseIdx = new Map(
    baseline.indexes.filter((i) => !i.primary && i.columns.length > 0).map((i) => [i.id, i]),
  );
  const curIdx = new Map(
    model.indexes.filter((i) => !i.primary && i.columns.length > 0).map((i) => [i.id, i]),
  );

  for (const index of baseIdx.values()) {
    const cur = curIdx.get(index.id);
    if (!cur || indexSignature(index) !== indexSignature(cur)) {
      const name = index.name.trim() || `idx_${index.columns.join("_")}`;
      stmts.push(`DROP INDEX IF EXISTS ${pgQuoteId(schema)}.${pgQuoteId(name)}`);
    }
  }

  for (const index of curIdx.values()) {
    const base = baseIdx.get(index.id);
    if (base && indexSignature(base) === indexSignature(index)) continue;
    const cols = index.columns.map((c) => pgQuoteId(c.trim())).join(", ");
    const name = pgQuoteId(index.name.trim() || `idx_${index.columns.join("_")}`);
    const unique = index.unique ? "UNIQUE " : "";
    stmts.push(`CREATE ${unique}INDEX ${name} ON ${tableRef} (${cols})`);
  }

  return stmts;
}
