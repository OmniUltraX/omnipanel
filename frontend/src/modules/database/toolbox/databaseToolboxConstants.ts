import type { SchemaTableDiff } from "./schemaDiff";
import type { SyncSideSnapshot } from "./types";

export const EMPTY_SNAPSHOT: SyncSideSnapshot = { tables: [], loading: false, error: null };

/** 逐条比对的行数门槛 */
export const LARGE_TABLE_ROW_THRESHOLD = 10_000;

/** 稳定空对象，避免 schemaDiffsForView 每次返回新 `{}` 触发对齐列表重算 */
export const EMPTY_SCHEMA_TABLE_DIFFS: Record<string, SchemaTableDiff> = {};

export const EXECUTE_TASK_KINDS = new Set([
  "dbDataSyncExecute",
  "dbDataSyncSqlExecute",
  "dbSchemaSyncExecute",
]);
export const TERMINAL_EXECUTE_STATUSES = new Set(["completed", "failed"]);

/** 跨组件实例去重：避免 Strict Mode / 重复订阅导致同步完成回调触发两次分析 */
const globalProcessedExecuteTaskIds = new Set<string>();

export function claimExecuteTaskCompletion(taskId: string): boolean {
  if (globalProcessedExecuteTaskIds.has(taskId)) {
    return false;
  }
  globalProcessedExecuteTaskIds.add(taskId);
  return true;
}
