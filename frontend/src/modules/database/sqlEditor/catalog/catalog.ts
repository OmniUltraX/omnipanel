import type { DatabaseSchema, TableSchema } from "../../types";
import type { Column, Database, Table } from "./schema";

export interface ResolvedTable {
  database: Database;
  table: Table;
  qualifiedTable: string;
}

function tableFromSchema(table: TableSchema): Table {
  return {
    name: table.name,
    kind: table.kind,
    comment: table.comment,
    columns: table.columns.map((col) => ({
      name: col.name,
      type: col.type,
      isPK: col.isPK,
      isFK: col.isFK,
      nullable: col.nullable,
      comment: col.comment,
    })),
  };
}

/** 内存中的 Schema Catalog：补全、Hover、语义高亮的数据源。 */
export class Catalog {
  readonly databases: Database[];

  constructor(databases: Database[]) {
    this.databases = databases;
  }

  static fromSchemas(schemas: DatabaseSchema[]): Catalog {
    return new Catalog(
      schemas.map((db) => ({
        name: db.name,
        connectionName: db.connectionName,
        dbType: db.dbType,
        tables: db.tables.map(tableFromSchema),
      })),
    );
  }

  toSchemas(): DatabaseSchema[] {
    return this.databases.map((db) => ({
      name: db.name,
      connectionName: db.connectionName,
      dbType: db.dbType,
      tables: db.tables.map((table) => ({
        name: table.name,
        kind: table.kind,
        comment: table.comment,
        columns: table.columns.map((col) => ({
          name: col.name,
          type: col.type,
          isPK: col.isPK,
          isFK: col.isFK,
          nullable: col.nullable,
          comment: col.comment,
        })),
      })),
    }));
  }

  findDatabase(name: string): Database | undefined {
    const key = name.toLowerCase();
    return this.databases.find((db) => db.name.toLowerCase() === key);
  }

  findTableInDatabase(database: Database | undefined, tableName: string): Table | undefined {
    if (!database) return undefined;
    const key = tableName.toLowerCase();
    return database.tables.find((table) => table.name.toLowerCase() === key);
  }

  findTable(tableName: string, databaseName?: string): ResolvedTable | null {
    if (databaseName) {
      const database = this.findDatabase(databaseName);
      const table = this.findTableInDatabase(database, tableName);
      if (table && database) {
        return { database, table, qualifiedTable: `${database.name}.${table.name}` };
      }
      return null;
    }

    for (const database of this.databases) {
      const table = this.findTableInDatabase(database, tableName);
      if (table) {
        return { database, table, qualifiedTable: table.name };
      }
    }
    return null;
  }

  findTablesByPrefix(prefix: string): ResolvedTable[] {
    if (!prefix) {
      return this.databases.flatMap((database) =>
        database.tables.map((table) => ({
          database,
          table,
          qualifiedTable: `${database.name}.${table.name}`,
        })),
      );
    }
    const key = prefix.toLowerCase();
    const matches: ResolvedTable[] = [];
    for (const database of this.databases) {
      for (const table of database.tables) {
        if (table.name.toLowerCase().startsWith(key)) {
          matches.push({ database, table, qualifiedTable: `${database.name}.${table.name}` });
        }
      }
    }
    return matches;
  }

  findColumn(tableName: string, columnName: string, databaseName?: string): Column | undefined {
    const resolved = this.findTable(tableName, databaseName);
    if (!resolved) return undefined;
    const key = columnName.toLowerCase();
    return resolved.table.columns.find((col) => col.name.toLowerCase() === key);
  }

  isTableName(name: string): boolean {
    const key = name.toLowerCase();
    return this.databases.some((db) =>
      db.tables.some((table) => table.name.toLowerCase() === key),
    );
  }

  isDatabaseName(name: string): boolean {
    return Boolean(this.findDatabase(name));
  }

  hasTables(): boolean {
    return this.databases.some((db) => db.tables.length > 0);
  }
}
