import type { ReactNode, MutableRefObject } from "react";
import type { RuleGroupType } from "react-querybuilder";
import type { DbColumnMeta, DbConnectionConfig } from "../api";
import type { SortState, SortStates } from "../workspace/dbWorkspaceState";
import type { TableSchema } from "../types";
import type { TableColumnRelation } from "./tableColumnRelation";
import type { DelimitedTextFormat } from "../shared/delimitedText";

export type TableDataGridActiveCell = {
  rowIndex: number;
  column: string;
  row: Record<string, unknown>;
};

export type TableDataGridProps = {
  columns: string[];
  rows: Record<string, unknown>[];
  totalRows: number;
  page: number;
  pageSize: number;
  loading: boolean;
  /** 隐藏底栏「of N rows」总行数（SQL 结果估算不准时用） */
  hideTotalRowCount?: boolean;
  onPageChange: (page: number) => void;
  columnMeta?: DbColumnMeta[];
  onCellEdit?: (cellInfo: { rowIndex: number; column: string; row: Record<string, unknown> }) => void;
  /** 单元格内联编辑提交（数字 / 短字符串等） */
  onCellCommit?: (
    cellInfo: { rowIndex: number; column: string; row: Record<string, unknown> },
    value: unknown,
  ) => void;
  onCellSetNull?: (cellInfo: { rowIndex: number; column: string; row: Record<string, unknown> }) => void;
  /** 已修改的行 key 集合（来自父组件脏数据状态），用于高亮 */
  dirtyRowKeys?: Set<string>;
  /** 待删除行的原始 row key（不含 __delete__: 前缀） */
  deletedRowKeys?: Set<string>;
  /** 单元覆盖：行 key -> 列名 -> 覆盖值；优先于 rows 展示 */
  cellOverrides?: Record<string, Record<string, unknown>>;
  /** 显示行列转换切换按钮（表数据预览） */
  enableTranspose?: boolean;
  /** 底部分页栏左侧工具按钮（表预览操作等） */
  toolbar?: ReactNode;
  /** 当前排序状态（表预览模式；多列，空数组表示无排序，兼容单对象） */
  sort?: SortState | SortStates | null;
  /** 排序变更回调（点击列头时触发；一律输出数组） */
  onSortChange?: (sort: SortStates) => void;
  /** 是否启用列头排序（表预览模式） */
  enableSort?: boolean;
  /** 当前过滤规则（表预览模式） */
  filter?: RuleGroupType | null;
  /** 过滤变更回调 */
  onFilterChange?: (filter: RuleGroupType | null) => void;
  /** 是否启用列过滤（表预览模式） */
  enableFilter?: boolean;
  /** 表预览 SQL 复制：数据库类型 */
  dbType?: string;
  /** 表预览 SQL 复制：表名 */
  tableName?: string;
  /**
   * 表预览 Tab id：启用时从 React 外 rowCache 读行并只 invalidate Canvas，
   * 加载分片不触发本组件 reconcile。
   */
  rowSourceTabId?: string;
  /** 隐藏的列名（受控，表预览持久化） */
  hiddenColumns?: string[];
  onHiddenColumnsChange?: (hiddenColumns: string[]) => void;
  /** 行列转置（受控，表预览持久化） */
  transposed?: boolean;
  onTransposedChange?: (transposed: boolean) => void;
  /** 底部分页栏中间区域（如 SQL 结果统计、导出等） */
  footerExtra?: ReactNode;
  /**
   * 分页/工具 chrome 位置。
   * - bottom：默认，底栏完整控件（SQL 结果等）
   * - none：隐藏底栏（表预览由外层顶栏接管）
   */
  chromePlacement?: "bottom" | "none";
  /** 外层顶栏调用网格内部动作（删除选中、列侧栏、复制 SQL） */
  gridActionsRef?: MutableRefObject<TableDataGridActions | null>;
  /** 选中行数量变化（供顶栏删除徽标） */
  onSelectedRowCountChange?: (count: number) => void;
  /** 底栏值编辑器是否折叠（表预览模式） */
  cellEditorCollapsed?: boolean;
  /** 为 true 时 Escape 不清除网格选中（详情面板展开等） */
  reserveSelectionOnEscape?: boolean;
  /** 切换底栏值编辑器展开/折叠 */
  onCellEditorCollapsedChange?: () => void;
  /** 双击单元格且值编辑器展开时，请求聚焦底栏编辑器 */
  onCellEditorFocusRequest?: () => void;
  /** 点击/拖选行号选中行时回调（用于切换到记录面板等） */
  onRowBandSelect?: () => void;
  /** 粘贴为新行（表预览编辑模式） */
  onRowPaste?: (payload: { values: Record<string, unknown> }) => void;
  /** 删除选中的行（表预览编辑模式）；返回是否成功标记删除 */
  onDeleteSelectedRows?: (
    rows: Array<{ rowIndex: number; row: Record<string, unknown> }>,
  ) => boolean | void;
  /** 当前选中的单个数据单元格（用于底栏编辑器等） */
  /** 当前选中的单元格集合（含多格选区） */
  onSelectedCellsChange?: (cells: TableDataGridActiveCell[]) => void;
  onActiveCellChange?: (cell: TableDataGridActiveCell | null) => void;
  /** 快速打开表设计器（表预览底栏） */
  onOpenTableDesign?: () => void;
  canOpenTableDesign?: boolean;
  /** 快速新建以当前表为上下文的 SQL 查询 */
  onCreateTableQuery?: () => void;
  canCreateTableQuery?: boolean;
  /** 可选关联目标表（表预览模式，用于列头关联配置） */
  relationTables?: TableSchema[];
  /** 关联查询所用连接（表预览模式） */
  relationConnection?: DbConnectionConfig;
  /** 关联查询所用数据库名（表预览模式） */
  relationDatabase?: string;
  /** 列关联配置（列名 -> 目标表.字段） */
  columnRelations?: Record<string, TableColumnRelation>;
  onColumnRelationsChange?: (relations: Record<string, TableColumnRelation>) => void;
  /** 状态栏 ActionBar 绑定的 dock panelId（与 tabId 一致） */
  statusBarActionPanelId?: string;
  /** 状态栏 InfoBar 绑定的 dock panelId；缺省时与 ActionBar 相同 */
  statusBarInfoPanelId?: string;
  /** 状态栏 InfoBar 展示内容（如表名、行数） */
  statusBarInfo?: ReactNode;
  /** 打开导出菜单（表预览顶栏同源） */
  onExportMenu?: (clientX: number, clientY: number) => void;
  /** 打开行详情（记录面板） */
  onOpenRowDetail?: () => void;
};

export type TableDataGridClipboardFormat = DelimitedTextFormat;

export type TableDataGridActions = {
  deleteSelectedRows: () => void;
  toggleColSidebar: () => void;
  copyPreviewSql: () => void;
  isColSidebarCollapsed: () => boolean;
  hasInlineEdit: () => boolean;
  cancelInlineEdit: () => void;
  hasSelection: () => boolean;
  clearSelection: () => void;
};
