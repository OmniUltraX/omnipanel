export interface ColumnSchema {
  name: string;
  type: string;
  isPK?: boolean;
  isFK?: boolean;
  nullable?: boolean;
  comment?: string;
}

export interface TableSchema {
  name: string;
  columns: ColumnSchema[];
  /** 表或视图，默认 table。 */
  kind?: "table" | "view";
  comment?: string;
}

export interface DatabaseSchema {
  name: string;
  tables: TableSchema[];
  /** 连接显示名（数据源）。 */
  connectionName?: string;
  /** 连接类型，如 mysql、postgresql。 */
  dbType?: string;
}
