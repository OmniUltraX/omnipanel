import type { SchemaFilterState } from "./DatabaseFilterDialog";

export interface SerializableSchemaFilter {
  orderedNames: string[];
  visibleNames: string[];
  pinnedNames?: string[];
}

export interface SchemaFiltersSnapshot {
  databaseFilters: Record<string, SerializableSchemaFilter>;
  tableFilters: Record<string, SerializableSchemaFilter>;
}

export function filterStateToSerializable(state: SchemaFilterState): SerializableSchemaFilter {
  return {
    orderedNames: [...state.orderedNames],
    visibleNames: [...state.visibleNames],
    ...(state.pinnedNames && state.pinnedNames.length > 0
      ? { pinnedNames: [...state.pinnedNames] }
      : {}),
  };
}

export function filterStateFromSerializable(data: SerializableSchemaFilter): SchemaFilterState {
  return {
    orderedNames: [...data.orderedNames],
    visibleNames: new Set(data.visibleNames),
    pinnedNames: data.pinnedNames ? [...data.pinnedNames] : [],
  };
}

export function snapshotToFilterStates(snapshot: SchemaFiltersSnapshot): {
  databaseFilters: Record<string, SchemaFilterState>;
  tableFilters: Record<string, SchemaFilterState>;
} {
  const databaseFilters: Record<string, SchemaFilterState> = {};
  for (const [key, value] of Object.entries(snapshot.databaseFilters ?? {})) {
    databaseFilters[key] = filterStateFromSerializable(value);
  }
  const tableFilters: Record<string, SchemaFilterState> = {};
  for (const [key, value] of Object.entries(snapshot.tableFilters ?? {})) {
    tableFilters[key] = filterStateFromSerializable(value);
  }
  return { databaseFilters, tableFilters };
}

export function filterStatesToSnapshot(
  databaseFilters: Record<string, SchemaFilterState>,
  tableFilters: Record<string, SchemaFilterState>,
): SchemaFiltersSnapshot {
  const databaseFiltersOut: Record<string, SerializableSchemaFilter> = {};
  for (const [key, value] of Object.entries(databaseFilters)) {
    databaseFiltersOut[key] = filterStateToSerializable(value);
  }
  const tableFiltersOut: Record<string, SerializableSchemaFilter> = {};
  for (const [key, value] of Object.entries(tableFilters)) {
    tableFiltersOut[key] = filterStateToSerializable(value);
  }
  return { databaseFilters: databaseFiltersOut, tableFilters: tableFiltersOut };
}
