import type { DbConnectionConfig, DbColumnMeta } from "./api";
import { introspectTable } from "./api";

/** 从服务端拉取完整列元数据（含备注），并写入 store。 */
export function fetchAndApplyTableColumnMeta(
  tabId: string,
  connection: DbConnectionConfig,
  dbName: string,
  tableName: string,
  apply: (columns: DbColumnMeta[]) => void,
): void {
  if (connection.db_type === "redis") {
    return;
  }
  void introspectTable(connection, dbName, tableName)
    .then((schema) => {
      apply(schema.columns);
    })
    .catch(() => {});
}

/** 判断列是否为自增（优先使用 schema 元数据，其次类型串特征）。 */
export function isAutoIncrementColumn(meta: DbColumnMeta, _pkCount: number): boolean {
  if (meta.isAutoIncrement === true) {
    return true;
  }
  if (meta.isAutoIncrement === false) {
    return false;
  }
  return /auto_increment|serial|identity/i.test(meta.type);
}
