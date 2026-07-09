/** 数据同步「确定 → SQL 预览」调试（开发环境默认开启，或 localStorage 手动开启） */
export const SYNC_EXECUTE_CONFIRM_DEBUG =
  import.meta.env.DEV ||
  (typeof localStorage !== "undefined" &&
    localStorage.getItem("omnipanel-db-sync-execute-confirm-debug") === "1");

const TAG = "[db-sync-execute-confirm]";

export function syncExecuteConfirmLog(
  step: string,
  data?: Record<string, unknown>,
): void {
  if (!SYNC_EXECUTE_CONFIRM_DEBUG) {
    return;
  }
  if (data && Object.keys(data).length > 0) {
    console.log(TAG, step, data);
  } else {
    console.log(TAG, step);
  }
}

export function syncExecuteConfirmWarn(
  step: string,
  data?: Record<string, unknown>,
): void {
  if (!SYNC_EXECUTE_CONFIRM_DEBUG) {
    return;
  }
  if (data && Object.keys(data).length > 0) {
    console.warn(TAG, step, data);
  } else {
    console.warn(TAG, step);
  }
}

export function summarizeSqlPreviewInput(
  input: {
    tab: string;
    sourceConn: { id: string; name: string; db_type: string };
    sourceDb: string;
    targetConn: { id: string; name: string; db_type: string };
    targetDb: string;
    tableNames: string[];
    tableTargetStatus: Record<string, string>;
    tableSyncModes: Record<string, { insert: boolean; merge: boolean; delete: boolean }>;
  } | null,
): Record<string, unknown> {
  if (!input) {
    return { input: null };
  }
  return {
    tab: input.tab,
    source: `${input.sourceConn.name}/${input.sourceDb}`,
    target: `${input.targetConn.name}/${input.targetDb}`,
    targetDbType: input.targetConn.db_type,
    tableNames: input.tableNames,
    modes: Object.fromEntries(
      input.tableNames.map((name) => [
        name,
        {
          status: input.tableTargetStatus[name] ?? null,
          syncModes: input.tableSyncModes[name] ?? null,
        },
      ]),
    ),
  };
}
