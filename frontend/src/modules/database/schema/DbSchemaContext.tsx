import { createContext, useContext, type ReactNode } from "react";
import type { DbConnectionConfig } from "../api";
import type { DatabaseSchema } from "../types";

/** 只读 Schema 上下文（连接列表、缓存 schema），与 Tab 写状态分离。 */
export interface DbSchemaContextValue {
  groupConnections: DbConnectionConfig[];
  databasesByConnId: Record<string, string[]>;
  schemaByKey: Record<string, DatabaseSchema>;
  schemaLoadingKey: string | null;
}

const DbSchemaContext = createContext<DbSchemaContextValue | null>(null);

export function DbSchemaProvider({
  value,
  children,
}: {
  value: DbSchemaContextValue;
  children: ReactNode;
}) {
  return <DbSchemaContext.Provider value={value}>{children}</DbSchemaContext.Provider>;
}

export function useDbSchemaContext(): DbSchemaContextValue {
  const ctx = useContext(DbSchemaContext);
  if (!ctx) {
    throw new Error("useDbSchemaContext must be used within DbSchemaProvider");
  }
  return ctx;
}
