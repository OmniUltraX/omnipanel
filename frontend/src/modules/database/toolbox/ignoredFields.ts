/** 规范化忽略字段条目：表.字段（大小写不敏感比较） */
export function normalizeIgnoredFieldEntry(entry: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed) {
    return null;
  }
  const dot = trimmed.indexOf(".");
  if (dot <= 0 || dot >= trimmed.length - 1) {
    return null;
  }
  const table = trimmed.slice(0, dot).trim();
  const column = trimmed.slice(dot + 1).trim();
  if (!table || !column) {
    return null;
  }
  return `${table}.${column}`.toLowerCase();
}

/** 从多行文本或数组解析忽略字段列表（去重、校验格式） */
export function parseIgnoredFieldsInput(input: string | string[] | undefined): string[] {
  const lines = Array.isArray(input) ? input : (input ?? "").split(/\r?\n/);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const key = normalizeIgnoredFieldEntry(trimmed);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

export function formatIgnoredFieldsForInput(fields: string[] | undefined): string {
  return (fields ?? []).join("\n");
}

export function isIgnoredCompareColumn(
  table: string,
  column: string,
  fields: string[],
): boolean {
  const key = `${table}.${column}`.toLowerCase();
  const wildcardKey = `*.${column}`.toLowerCase();
  return fields.some((entry) => {
    const normalized = normalizeIgnoredFieldEntry(entry);
    return normalized === key || normalized === wildcardKey;
  });
}

/** 某张表在冲突详情中应标记为忽略的列名（小写） */
export function ignoredColumnsForTable(table: string, fields: string[]): Set<string> {
  const tableLower = table.toLowerCase();
  const prefix = `${tableLower}.`;
  const columns = new Set<string>();
  for (const entry of fields) {
    const normalized = normalizeIgnoredFieldEntry(entry);
    if (!normalized) {
      continue;
    }
    if (normalized.startsWith(prefix)) {
      columns.add(normalized.slice(prefix.length));
      continue;
    }
    if (normalized.startsWith("*.")) {
      columns.add(normalized.slice(2));
    }
  }
  return columns;
}

export function filterChangedFieldsByIgnored(
  table: string,
  changedFields: string[] | undefined,
  fields: string[],
): string[] {
  if (!changedFields || changedFields.length === 0 || fields.length === 0) {
    return changedFields ?? [];
  }
  return changedFields.filter((column) => !isIgnoredCompareColumn(table, column, fields));
}

/** 对比分析结果：剔除忽略列后重算 diff 行与状态 */
export function applyIgnoredFieldsToAnalysisResult<T extends {
  status: string;
  diffRows?: number;
  diffs?: Array<{
    kind: string;
    changedFields?: string[];
  }>;
  diffCacheId?: string;
}>(
  table: string,
  result: T,
  fields: string[],
): T {
  if (result.status !== "diff" || fields.length === 0) {
    return result;
  }

  const diffs = result.diffs ?? [];
  const filteredDiffs = diffs.flatMap((diff) => {
    if (diff.kind !== "changed") {
      return [diff];
    }
    const changedFields = filterChangedFieldsByIgnored(table, diff.changedFields, fields);
    if (changedFields.length === 0) {
      return [];
    }
    if (changedFields.length === (diff.changedFields?.length ?? 0)) {
      return [diff];
    }
    return [{ ...diff, changedFields }];
  });

  if (filteredDiffs.length === 0) {
    if ((result.diffs?.length ?? 0) === 0 && result.diffCacheId) {
      return result;
    }
    return {
      ...result,
      status: "match",
      diffRows: 0,
      diffs: [],
      diffCacheId: result.diffCacheId,
    };
  }

  const unchanged =
    filteredDiffs.length === diffs.length &&
    filteredDiffs.every((diff, index) => {
      const original = diffs[index];
      if (diff === original) {
        return true;
      }
      if (diff.kind !== original.kind) {
        return false;
      }
      const left = diff.changedFields ?? [];
      const right = original.changedFields ?? [];
      return left.length === right.length && left.every((field, i) => field === right[i]);
    });
  if (unchanged) {
    return result;
  }

  return {
    ...result,
    diffRows: filteredDiffs.length,
    diffs: filteredDiffs,
  };
}

/** 冲突详情：剔除忽略列后过滤单行 diff（changed 且仅剩忽略列时返回 null） */
export function filterTableRowDiffByIgnoredColumns(
  diff: {
    kind: string;
    changedFields?: string[];
  },
  ignoredColumns: Set<string>,
): typeof diff | null {
  if (diff.kind !== "changed" || ignoredColumns.size === 0) {
    return diff;
  }
  const changedFields = (diff.changedFields ?? []).filter(
    (column) => !ignoredColumns.has(column.toLowerCase()),
  );
  if (changedFields.length === 0) {
    return null;
  }
  if (changedFields.length === (diff.changedFields?.length ?? 0)) {
    return diff;
  }
  return { ...diff, changedFields };
}
