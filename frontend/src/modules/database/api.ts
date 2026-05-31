import { invoke } from "@tauri-apps/api/core";
import type { SchemaFiltersSnapshot } from "./schemaFilters";

export interface DbConnectionConfig {
  id: string;
  name: string;
  db_type: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  group: string;
  status: string;
}

export function normalizeConnectionGroup(group: string): string {
  if (!group.trim() || group === "default") {
    return "默认";
  }
  return group.trim();
}

export function connectionMatchesGroup(connection: DbConnectionConfig, groupName: string): boolean {
  return normalizeConnectionGroup(connection.group) === groupName;
}

export interface ConnectionFormData {
  engine: "postgresql" | "mysql" | "sqlite" | "sqlserver" | "redis" | "mongodb";
  name: string;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
  group: string;
}

export function formToConnection(form: ConnectionFormData, id = ""): DbConnectionConfig {
  const port = Number.parseInt(form.port, 10);
  return {
    id,
    name: form.name.trim() || form.host.trim() || "Untitled",
    db_type: form.engine,
    host: form.host.trim(),
    port: Number.isFinite(port) ? port : 0,
    user: form.username.trim(),
    password: form.password,
    database: form.database.trim(),
    group: form.group.trim() || "默认",
    status: "unknown",
  };
}

export function isSupportedEngine(engine: ConnectionFormData["engine"]): boolean {
  return engine === "mysql";
}

export async function listConnections(): Promise<DbConnectionConfig[]> {
  return invoke<DbConnectionConfig[]>("db_list_connections");
}

export async function loadSchemaFilters(): Promise<SchemaFiltersSnapshot> {
  return invoke<SchemaFiltersSnapshot>("db_load_schema_filters");
}

export async function saveSchemaFilters(snapshot: SchemaFiltersSnapshot): Promise<void> {
  return invoke<void>("db_save_schema_filters", { snapshot });
}

export async function saveConnection(connection: DbConnectionConfig): Promise<DbConnectionConfig> {
  return invoke<DbConnectionConfig>("db_save_connection", { connection });
}

export async function testConnection(connection: DbConnectionConfig): Promise<string> {
  return invoke<string>("db_test_connection", { connection });
}

export async function listDatabases(connection: DbConnectionConfig): Promise<string[]> {
  return invoke<string[]>("db_list_databases", { connection });
}

export interface DbColumnMeta {
  name: string;
  type: string;
  isPk: boolean;
  isFk: boolean;
}

export interface DbIndexMeta {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface DbTableSchema {
  name: string;
  columns: DbColumnMeta[];
  indexes?: DbIndexMeta[];
}

export interface DbIntrospectResult {
  database: string;
  tables: DbTableSchema[];
}

export async function introspectSchema(
  connection: DbConnectionConfig,
  database?: string,
): Promise<DbIntrospectResult> {
  return invoke<DbIntrospectResult>("db_introspect_schema", {
    connection,
    schema: database?.trim() ? database.trim() : null,
  });
}

export async function introspectTable(
  connection: DbConnectionConfig,
  database: string,
  table: string,
): Promise<DbTableSchema> {
  return invoke<DbTableSchema>("db_introspect_table", {
    connection,
    schema: database.trim() ? database.trim() : null,
    table,
  });
}

export async function listTables(
  connection: DbConnectionConfig,
  schema?: string
): Promise<string[]> {
  return invoke<string[]>("db_list_tables", {
    connection,
    schema: schema?.trim() ? schema.trim() : null,
  });
}

export interface TablePreviewResult {
  name: string;
  columns: string[];
  rows: Record<string, unknown>[];
}

export async function previewTable(
  connection: DbConnectionConfig,
  table: string,
  limit = 200,
): Promise<TablePreviewResult> {
  return invoke<TablePreviewResult>("db_preview_table", { connection, table, limit });
}
