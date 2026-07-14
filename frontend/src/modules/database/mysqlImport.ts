import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { formatIpcError, type IpcErrorLike } from "../../ipc/result";
import type { BackgroundTaskInfo } from "../../stores/backgroundTaskStore";
import type { DbConnectionConfig } from "./api";
import type { MysqlExportDeploymentOption } from "./mysqlExport";

export type MysqlImportSource =
  | { kind: "file"; filePath: string }
  | { kind: "export"; exportId: string };

function formatMysqlImportError(error: unknown): string {
  return formatIpcError(error as IpcErrorLike);
}

export async function submitDbMysqlImport(
  connection: DbConnectionConfig,
  databaseName: string,
  deployment: MysqlExportDeploymentOption,
  source: MysqlImportSource,
): Promise<string> {
  try {
    return await invoke<string>("bg_task_submit_db_mysql_import", {
      connection,
      databaseName,
      deployment,
      source:
        source.kind === "file"
          ? { kind: "file", filePath: source.filePath }
          : { kind: "export", exportId: source.exportId },
    });
  } catch (error) {
    throw new Error(formatMysqlImportError(error));
  }
}

/** 在提交导入前注册监听，收到终态后自动取消并回调。 */
export async function beginWatchMysqlImportTask(
  onTerminal: (task: BackgroundTaskInfo) => void,
): Promise<{ bindTaskId: (taskId: string) => void; cancel: () => void }> {
  let settled = false;
  let taskId: string | null = null;
  let unlisten: (() => void) | undefined;
  const cancel = () => {
    if (settled) return;
    settled = true;
    unlisten?.();
  };
  unlisten = await listen<BackgroundTaskInfo>("bg-task-update", (event) => {
    const task = event.payload;
    if (settled || !taskId || task.id !== taskId) return;
    if (task.kind !== "dbMysqlImport") return;
    if (task.status !== "failed" && task.status !== "completed" && task.status !== "cancelled") {
      return;
    }
    onTerminal(task);
    cancel();
  });
  window.setTimeout(cancel, 2 * 60 * 60 * 1000);
  return {
    bindTaskId: (id) => {
      taskId = id;
    },
    cancel,
  };
}
