/** 冲突字段取值侧：源表或目标表 */
export type RowDiffFieldSide = "source" | "target";

/** rowKey -> columnName -> side */
export type RowDiffFieldResolutions = Record<string, Record<string, RowDiffFieldSide>>;

export function getRowDiffFieldResolution(
  resolutions: RowDiffFieldResolutions,
  rowKey: string,
  columnName: string,
): RowDiffFieldSide | undefined {
  return resolutions[rowKey]?.[columnName];
}

export function setRowDiffFieldResolution(
  resolutions: RowDiffFieldResolutions,
  rowKey: string,
  columnName: string,
  side: RowDiffFieldSide,
): RowDiffFieldResolutions {
  const row = resolutions[rowKey] ?? {};
  return {
    ...resolutions,
    [rowKey]: { ...row, [columnName]: side },
  };
}

export function setRowDiffAllChangedFields(
  resolutions: RowDiffFieldResolutions,
  rowKey: string,
  changedFields: string[],
  side: RowDiffFieldSide,
): RowDiffFieldResolutions {
  if (changedFields.length === 0) {
    return resolutions;
  }
  const row = { ...(resolutions[rowKey] ?? {}) };
  for (const field of changedFields) {
    row[field] = side;
  }
  return { ...resolutions, [rowKey]: row };
}
