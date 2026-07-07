import { useMemo } from "react";
import { useDbSchemaCacheStore } from "../../../stores/dbSchemaCacheStore";
import { useDbSchemaContext } from "../schema/DbSchemaContext";
import {
  buildDatabaseSchema,
  introspectToTableSchemas,
} from "../sqlEditor/language/completionItems";
import type { DatabaseSchema } from "../types";
import type { DbConnectionConfig } from "../api";

export function useTreeChartDatabaseSchema(
  connection: DbConnectionConfig | null,
  database: string,
): DatabaseSchema | null {
  const { schemaByKey } = useDbSchemaContext();
  const snapshot = useDbSchemaCacheStore((state) => state.snapshot);

  return useMemo(() => {
    if (!connection || !database.trim()) {
      return null;
    }
    const key = `${connection.id}:${database}`;
    const cached = schemaByKey[key];
    if (cached) {
      return cached;
    }
    const dbEntry = snapshot.connections[connection.id]?.databases.find(
      (entry) => entry.name === database,
    );
    if (!dbEntry) {
      return null;
    }
    const tables = [
      ...introspectToTableSchemas(dbEntry.tables, "table"),
      ...introspectToTableSchemas(dbEntry.views ?? [], "view"),
    ];
    return buildDatabaseSchema(database, tables, {
      connectionName: connection.name,
      dbType: connection.db_type,
    });
  }, [connection, database, schemaByKey, snapshot]);
}
