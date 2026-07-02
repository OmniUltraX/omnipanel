import { usePersistedModuleTab } from "../../../hooks/usePersistedModuleTab";

export type DbModuleTab = "query" | "dataSync" | "schemaSync";

const DB_MODULE_TABS: DbModuleTab[] = ["query", "dataSync", "schemaSync"];

/** 数据库模块功能模式（query / dataSync / schemaSync）持久化 */
export function useDatabaseModuleMode() {
  return usePersistedModuleTab("database", "query", DB_MODULE_TABS);
}
