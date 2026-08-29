import { useEffect, useRef, type ReactNode } from "react";

export type ImportPreviewColumn<T> = {
  id: string;
  header: string;
  width?: number;
  minWidth?: number;
  render: (item: T) => ReactNode;
};

export type ImportPreviewItem = {
  id: string;
  disabled?: boolean;
};

export type ImportPreviewProps<T extends ImportPreviewItem> = {
  items: T[];
  columns: ImportPreviewColumn<T>[];
  selectedIds: Set<string>;
  onToggle: (id: string, next: boolean) => void;
  renderStatus?: (item: T) => ReactNode;
  /** 表头全选复选框的无障碍标签 */
  selectAllLabel?: string;
};

/** 宿主导入预览表。插件不得 import 各业务 module。 */
export function ImportPreview<T extends ImportPreviewItem>({
  items,
  columns,
  selectedIds,
  onToggle,
  selectAllLabel,
}: ImportPreviewProps<T>) {
  const selectable = items.filter((item) => !item.disabled);
  const selectedCount = selectable.filter((item) => selectedIds.has(item.id)).length;
  const allChecked = selectable.length > 0 && selectedCount === selectable.length;
  const someChecked = selectedCount > 0 && !allChecked;
  const selectAllRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = selectAllRef.current;
    if (!el) return;
    el.indeterminate = someChecked;
  }, [someChecked]);

  return (
    <div className="db-import-preview-table-wrap">
      <table className="db-import-preview-table">
        <thead>
          <tr>
            <th style={{ width: 40 }}>
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allChecked}
                disabled={selectable.length === 0}
                aria-label={selectAllLabel}
                title={selectAllLabel}
                onChange={(event) => {
                  const next = event.target.checked;
                  for (const item of selectable) {
                    onToggle(item.id, next);
                  }
                }}
              />
            </th>
            {columns.map((col) => (
              <th key={col.id} style={{ width: col.width, minWidth: col.minWidth }}>
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const checked = selectedIds.has(item.id);
            return (
              <tr key={item.id} className={item.disabled ? "is-disabled" : undefined}>
                <td>
                  <input
                    type="checkbox"
                    disabled={item.disabled}
                    checked={checked}
                    onChange={(event) => onToggle(item.id, event.target.checked)}
                  />
                </td>
                {columns.map((col) => (
                  <td key={col.id}>{col.render(item)}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
