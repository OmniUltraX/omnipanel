import type { ReactNode } from "react";

export function RowDiffResizableTh({
  colId,
  width,
  className,
  resizable = true,
  onResizeStart,
  onResizeReset,
  children,
}: {
  colId: string;
  width: number;
  className?: string;
  resizable?: boolean;
  onResizeStart: (colId: string, clientX: number, startWidth: number) => void;
  onResizeReset: (colId: string) => void;
  children: ReactNode;
}) {
  const style = { width, minWidth: width, maxWidth: width };

  return (
    <th data-col-id={colId} className={className} style={style}>
      <span className="db-toolbox-row-diff-th-label">{children}</span>
      {resizable ? (
        <div
          className="db-col-resize-handle"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onResizeStart(colId, event.clientX, width);
          }}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onResizeReset(colId);
          }}
          title="Drag to resize"
        />
      ) : null}
    </th>
  );
}

export function rowDiffTdProps(colId: string, width: number) {
  return {
    "data-col-id": colId,
    style: { width, minWidth: width, maxWidth: width },
  } as const;
}
