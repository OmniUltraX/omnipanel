import type { ReactNode } from "react";
import type { ContextMenuItem } from "../../../components/ui/menu/ContextMenu";

function MenuIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden
    >
      {children}
    </svg>
  );
}

export const gridContextMenuIcons = {
  sortDbAsc: (
    <MenuIcon>
      <rect x="2.5" y="3" width="7" height="10" rx="1" />
      <path d="M11.5 11.5V4.5M11.5 4.5 13.2 6.2M11.5 4.5 9.8 6.2" strokeLinecap="round" strokeLinejoin="round" />
    </MenuIcon>
  ),
  sortDbDesc: (
    <MenuIcon>
      <rect x="2.5" y="3" width="7" height="10" rx="1" />
      <path d="M11.5 4.5v7M11.5 11.5 13.2 9.8M11.5 11.5 9.8 9.8" strokeLinecap="round" strokeLinejoin="round" />
    </MenuIcon>
  ),
  sortAsc: (
    <MenuIcon>
      <path d="M4 11.5 8 4.5 12 11.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5.8 8.5h4.4" strokeLinecap="round" />
    </MenuIcon>
  ),
  sortDesc: (
    <MenuIcon>
      <path d="M4 4.5 8 11.5 12 4.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5.8 7.5h4.4" strokeLinecap="round" />
    </MenuIcon>
  ),
  filter: (
    <MenuIcon>
      <path d="M2.5 3.5h11l-4 4.5v3.5L6.5 13V8z" strokeLinejoin="round" />
    </MenuIcon>
  ),
  cellDetail: (
    <MenuIcon>
      <path d="M6 3.5H3.5V6M10 3.5h2.5V6M6 12.5H3.5V10M10 12.5h2.5V10" strokeLinecap="round" />
    </MenuIcon>
  ),
  columnDetail: (
    <MenuIcon>
      <rect x="2.5" y="3" width="11" height="10" rx="1" />
      <path d="M6.5 3v10M10 3v10" />
    </MenuIcon>
  ),
  rowDetail: (
    <MenuIcon>
      <rect x="2.5" y="3" width="11" height="10" rx="1" />
      <path d="M2.5 6.5h11M2.5 10h11" />
    </MenuIcon>
  ),
  copy: (
    <MenuIcon>
      <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1" />
      <path d="M3.5 10.5V3.5A1 1 0 0 1 4.5 2.5H10" />
    </MenuIcon>
  ),
  setNull: (
    <MenuIcon>
      <circle cx="8" cy="8" r="5" />
      <path d="M5.5 5.5 10.5 10.5" strokeLinecap="round" />
    </MenuIcon>
  ),
  batchEdit: (
    <MenuIcon>
      <path d="M3.5 12.5 5 8l7-7 2 2-7 7z" strokeLinejoin="round" />
      <path d="M10.5 3.5 12.5 5.5" strokeLinecap="round" />
    </MenuIcon>
  ),
  transpose: (
    <MenuIcon>
      <path d="M3 4.5h10M3 8h10M3 11.5h10" strokeLinecap="round" />
      <path d="M6.5 3v10" strokeLinecap="round" />
    </MenuIcon>
  ),
  selection: (
    <MenuIcon>
      <rect x="3" y="3" width="10" height="10" rx="1" strokeDasharray="2 1.5" />
    </MenuIcon>
  ),
  clone: (
    <MenuIcon>
      <rect x="4" y="4" width="8" height="8" rx="1" />
      <path d="M8 6.5v3M6.5 8h3" strokeLinecap="round" />
    </MenuIcon>
  ),
  trash: (
    <MenuIcon>
      <path d="M3.5 4.5h9M6 4.5V3.5h4v1" strokeLinecap="round" />
      <path d="M5.5 4.5l.5 8h4l.5-8" strokeLinejoin="round" />
    </MenuIcon>
  ),
  export: (
    <MenuIcon>
      <path d="M8 10.5V3.5M5.5 6 8 3.5 10.5 6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.5 12.5h9" strokeLinecap="round" />
    </MenuIcon>
  ),
};

export type TableDataGridContextMenuLabels = {
  sortDbAsc: string;
  sortDbDesc: string;
  sortPageAsc: string;
  sortPageDesc: string;
  filter: string;
  filterColumn: string;
  filterClear: string;
  cellDetail: string;
  columnDetail: string;
  rowDetail: string;
  copy: string;
  copyCell: string;
  copyRowsJson: string;
  copyInsertMerged: string;
  copyInsertPerRow: string;
  copyInsertNoPkMerged: string;
  copyInsertNoPkPerRow: string;
  copyUpdate: string;
  copyAllTsv: string;
  copyAllColumnNames: string;
  setNull: string;
  batchEdit: string;
  transpose: string;
  selection: string;
  selectRow: string;
  selectColumn: string;
  selectAll: string;
  clearSelection: string;
  cloneRows: string;
  deleteRows: string;
  export: string;
};

export type TableDataGridContextMenuActions = {
  canSortDb: boolean;
  canSortPage: boolean;
  canFilter: boolean;
  canSetNull: boolean;
  setNullDisabled: boolean;
  canBatchEdit: boolean;
  canTranspose: boolean;
  canClone: boolean;
  canDelete: boolean;
  canExport: boolean;
  canCopySql: boolean;
  hasSelection: boolean;
  selectedRowCount: number;
  rowActionsEnabled: boolean;
  onSortDbAsc: () => void;
  onSortDbDesc: () => void;
  onSortPageAsc: () => void;
  onSortPageDesc: () => void;
  onFilterColumn: () => void;
  onFilterClear: () => void;
  onCellDetail: () => void;
  onColumnDetail: () => void;
  onRowDetail: () => void;
  onCopyCell: () => void;
  onCopyRowsJson: () => void;
  onCopyInsertMerged: () => void;
  onCopyInsertPerRow: () => void;
  onCopyInsertNoPkMerged: () => void;
  onCopyInsertNoPkPerRow: () => void;
  onCopyUpdate: () => void;
  onCopyAllTsv: () => void;
  onCopyAllColumnNames: () => void;
  onSetNull: () => void;
  onBatchEdit: () => void;
  onTranspose: () => void;
  onSelectRow: () => void;
  onSelectColumn: () => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onCloneRows: () => void;
  onDeleteRows: () => void;
  onExport: () => void;
};

function sep(id: string): ContextMenuItem {
  return { id, label: "", separator: true };
}

export function buildTableDataGridContextMenuItems(
  labels: TableDataGridContextMenuLabels,
  actions: TableDataGridContextMenuActions,
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];

  if (actions.canSortDb) {
    items.push(
      {
        id: "sort-db-asc",
        label: labels.sortDbAsc,
        icon: gridContextMenuIcons.sortDbAsc,
        onClick: actions.onSortDbAsc,
      },
      {
        id: "sort-db-desc",
        label: labels.sortDbDesc,
        icon: gridContextMenuIcons.sortDbDesc,
        onClick: actions.onSortDbDesc,
      },
    );
  }

  if (actions.canSortPage) {
    if (items.length > 0) items.push(sep("sep-sort"));
    items.push(
      {
        id: "sort-page-asc",
        label: labels.sortPageAsc,
        icon: gridContextMenuIcons.sortAsc,
        onClick: actions.onSortPageAsc,
      },
      {
        id: "sort-page-desc",
        label: labels.sortPageDesc,
        icon: gridContextMenuIcons.sortDesc,
        onClick: actions.onSortPageDesc,
      },
    );
  }

  if (actions.canFilter) {
    items.push(sep("sep-filter"), {
      id: "filter",
      label: labels.filter,
      icon: gridContextMenuIcons.filter,
      children: [
        {
          id: "filter-column",
          label: labels.filterColumn,
          onClick: actions.onFilterColumn,
        },
        {
          id: "filter-clear",
          label: labels.filterClear,
          onClick: actions.onFilterClear,
        },
      ],
    });
  }

  items.push(
    sep("sep-detail"),
    {
      id: "cell-detail",
      label: labels.cellDetail,
      icon: gridContextMenuIcons.cellDetail,
      onClick: actions.onCellDetail,
    },
    {
      id: "column-detail",
      label: labels.columnDetail,
      icon: gridContextMenuIcons.columnDetail,
      onClick: actions.onColumnDetail,
      disabled: !actions.rowActionsEnabled,
    },
    {
      id: "row-detail",
      label: labels.rowDetail,
      icon: gridContextMenuIcons.rowDetail,
      onClick: actions.onRowDetail,
      disabled: !actions.rowActionsEnabled,
    },
  );

  const copyChildren: ContextMenuItem[] = [
    {
      id: "copy-cell",
      label: labels.copyCell,
      onClick: actions.onCopyCell,
    },
  ];
  if (actions.rowActionsEnabled) {
    copyChildren.push({
      id: "copy-rows-json",
      label: labels.copyRowsJson,
      onClick: actions.onCopyRowsJson,
    });
    if (actions.canCopySql) {
      copyChildren.push(
        {
          id: "copy-insert-merged",
          label: labels.copyInsertMerged,
          onClick: actions.onCopyInsertMerged,
        },
        {
          id: "copy-insert-per-row",
          label: labels.copyInsertPerRow,
          onClick: actions.onCopyInsertPerRow,
        },
        {
          id: "copy-insert-nopk-merged",
          label: labels.copyInsertNoPkMerged,
          onClick: actions.onCopyInsertNoPkMerged,
        },
        {
          id: "copy-insert-nopk-per-row",
          label: labels.copyInsertNoPkPerRow,
          onClick: actions.onCopyInsertNoPkPerRow,
        },
        {
          id: "copy-update",
          label: labels.copyUpdate,
          onClick: actions.onCopyUpdate,
        },
      );
    }
  }
  copyChildren.push(
    {
      id: "copy-all-tsv",
      label: labels.copyAllTsv,
      onClick: actions.onCopyAllTsv,
    },
    {
      id: "copy-all-colnames",
      label: labels.copyAllColumnNames,
      onClick: actions.onCopyAllColumnNames,
    },
  );

  items.push(sep("sep-edit"), {
    id: "copy",
    label: labels.copy,
    icon: gridContextMenuIcons.copy,
    children: copyChildren,
  });

  if (actions.canSetNull && actions.rowActionsEnabled) {
    items.push({
      id: "set-null",
      label: labels.setNull,
      icon: gridContextMenuIcons.setNull,
      disabled: actions.setNullDisabled,
      onClick: actions.onSetNull,
    });
  }

  if (actions.canBatchEdit && actions.rowActionsEnabled) {
    items.push({
      id: "batch-edit",
      label: labels.batchEdit,
      icon: gridContextMenuIcons.batchEdit,
      onClick: actions.onBatchEdit,
    });
  }

  if (actions.canTranspose) {
    items.push({
      id: "transpose",
      label: labels.transpose,
      icon: gridContextMenuIcons.transpose,
      onClick: actions.onTranspose,
    });
  }

  items.push({
    id: "selection",
    label: labels.selection,
    icon: gridContextMenuIcons.selection,
    children: [
      {
        id: "select-row",
        label: labels.selectRow,
        onClick: actions.onSelectRow,
        disabled: !actions.rowActionsEnabled,
      },
      {
        id: "select-column",
        label: labels.selectColumn,
        onClick: actions.onSelectColumn,
        disabled: !actions.rowActionsEnabled,
      },
      {
        id: "select-all",
        label: labels.selectAll,
        onClick: actions.onSelectAll,
      },
      {
        id: "clear-selection",
        label: labels.clearSelection,
        onClick: actions.onClearSelection,
        disabled: !actions.hasSelection,
      },
    ],
  });

  if (actions.rowActionsEnabled && (actions.canClone || actions.canDelete)) {
    items.push(sep("sep-rows"));
    if (actions.canClone) {
      items.push({
        id: "clone-rows",
        label: labels.cloneRows,
        icon: gridContextMenuIcons.clone,
        onClick: actions.onCloneRows,
      });
    }
    if (actions.canDelete) {
      items.push({
        id: "delete-rows",
        label: labels.deleteRows,
        icon: gridContextMenuIcons.trash,
        danger: true,
        onClick: actions.onDeleteRows,
      });
    }
  }

  if (actions.canExport) {
    items.push(sep("sep-export"), {
      id: "export",
      label: labels.export,
      icon: gridContextMenuIcons.export,
      onClick: actions.onExport,
    });
  }

  return items;
}
