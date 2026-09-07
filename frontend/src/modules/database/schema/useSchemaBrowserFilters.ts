import { useCallback, useState } from "react";
import { useDbSchemaFilterStore } from "../../../stores/dbSchemaFilterStore";
import { makeTableFilterKey, mergeFilter } from "./DatabaseFilterDialog";

/** SchemaBrowser 过滤状态与同步：从主组件抽离以收窄订阅面。 */
export function useSchemaBrowserFilters() {
  const databaseFilters = useDbSchemaFilterStore((s) => s.databaseFilters);
  const tableFilters = useDbSchemaFilterStore((s) => s.tableFilters);
  const filtersHydrated = useDbSchemaFilterStore((s) => s.hydrated);
  const hydrateSchemaFilters = useDbSchemaFilterStore((s) => s.hydrate);
  const setDatabaseFilters = useDbSchemaFilterStore((s) => s.setDatabaseFilters);
  const setTableFilters = useDbSchemaFilterStore((s) => s.setTableFilters);
  const [filterDialogConnId, setFilterDialogConnId] = useState<string | null>(null);
  const [filterDialogTable, setFilterDialogTable] = useState<{
    connId: string;
    dbName: string;
  } | null>(null);

  const syncDatabaseFilter = useCallback((connId: string, names: string[]) => {
    setDatabaseFilters((prev) => ({
      ...prev,
      [connId]: mergeFilter(prev[connId], names),
    }));
  }, [setDatabaseFilters]);

  const syncTableFilter = useCallback(
    (connId: string, dbName: string, names: string[], options?: { showAll?: boolean }) => {
      const key = makeTableFilterKey(connId, dbName);
      setTableFilters((prev) => ({
        ...prev,
        [key]: mergeFilter(prev[key], names, options),
      }));
    },
    [setTableFilters],
  );

  return {
    databaseFilters,
    tableFilters,
    filtersHydrated,
    hydrateSchemaFilters,
    setDatabaseFilters,
    setTableFilters,
    filterDialogConnId,
    setFilterDialogConnId,
    filterDialogTable,
    setFilterDialogTable,
    syncDatabaseFilter,
    syncTableFilter,
  };
}
