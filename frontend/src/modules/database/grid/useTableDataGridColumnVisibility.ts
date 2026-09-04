import { useCallback, useMemo, useState } from "react";

type HiddenUpdater = Set<string> | ((prev: Set<string>) => Set<string>);
type BoolUpdater = boolean | ((prev: boolean) => boolean);

/**
 * 表网格列显隐 / 转置受控或本地状态。
 * 从 TableDataGrid 抽离，降低主文件编排体积。
 */
export function useTableDataGridColumnVisibility(options: {
  hiddenColumnsProp?: string[];
  onHiddenColumnsChange?: (hiddenColumns: string[]) => void;
  transposedProp?: boolean;
  onTransposedChange?: (transposed: boolean) => void;
}) {
  const {
    hiddenColumnsProp,
    onHiddenColumnsChange,
    transposedProp,
    onTransposedChange,
  } = options;
  const isHiddenColumnsControlled = onHiddenColumnsChange != null;
  const isTransposedControlled = onTransposedChange != null;
  const [localHiddenColumns, setLocalHiddenColumns] = useState<Set<string>>(
    () => new Set(),
  );
  const [localTransposed, setLocalTransposed] = useState(false);

  const hiddenColumns = useMemo(() => {
    if (isHiddenColumnsControlled) {
      return new Set(hiddenColumnsProp ?? []);
    }
    return localHiddenColumns;
  }, [isHiddenColumnsControlled, hiddenColumnsProp, localHiddenColumns]);

  const transposed = isTransposedControlled ? (transposedProp ?? false) : localTransposed;

  const setHiddenColumns = useCallback(
    (updater: HiddenUpdater) => {
      const next = typeof updater === "function" ? updater(hiddenColumns) : updater;
      if (isHiddenColumnsControlled) {
        onHiddenColumnsChange!([...next]);
        return;
      }
      setLocalHiddenColumns(next);
    },
    [hiddenColumns, isHiddenColumnsControlled, onHiddenColumnsChange],
  );

  const setTransposed = useCallback(
    (updater: BoolUpdater) => {
      const next = typeof updater === "function" ? updater(transposed) : updater;
      if (isTransposedControlled) {
        onTransposedChange!(next);
        return;
      }
      setLocalTransposed(next);
    },
    [transposed, isTransposedControlled, onTransposedChange],
  );

  return { hiddenColumns, transposed, setHiddenColumns, setTransposed };
}
