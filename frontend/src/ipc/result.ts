/**
 * Tauri specta `commands.*` 的 Result 解包与错误格式化。
 *
 * 约定：业务 IPC 走 `commands.*` + `unwrapCommand` / `unwrapCommandResult`，
 * 不要再复制一份 local unwrap，也不要为业务命令新写裸 `invoke`。
 */

import type { OmniError_Serialize } from "./bindings";

/** specta typedError 返回的 ok/error envelope */
export type CommandResult<T, E = OmniError_Serialize | string> =
  | { status: "ok"; data: T }
  | { status: "error"; error: E };

export type IpcErrorLike =
  | OmniError_Serialize
  | string
  | { message?: string; cause?: string | null; code?: string };

function isIpcErrorLike(error: unknown): error is IpcErrorLike {
  if (typeof error === "string") return true;
  if (!error || typeof error !== "object") return false;
  return "message" in error || "cause" in error || "code" in error;
}

/** 将 OmniError / string / 未知异常格式化为面向用户的完整提示（保留 cause）。 */
export function formatIpcError(error: IpcErrorLike | unknown): string {
  if (!isIpcErrorLike(error)) {
    if (error instanceof Error) {
      const trimmed = error.message.trim();
      return trimmed || "请求失败";
    }
    if (error == null) return "请求失败";
    return String(error);
  }
  if (typeof error === "string") {
    const trimmed = error.trim();
    return trimmed || "请求失败";
  }
  const message = (error.message ?? "").trim() || "请求失败";
  const cause = error.cause?.trim();
  if (!cause) return message;
  return `${message}：${cause}`;
}

/** 构造带 code/cause 的 Error，便于上层区分。 */
export function ipcErrorToError(error: IpcErrorLike): Error {
  if (typeof error === "string") {
    return new Error(formatIpcError(error));
  }
  const err = new Error(formatIpcError(error));
  Object.assign(err, {
    code: error.code ?? null,
    cause: error.cause ?? null,
  });
  return err;
}

export type UnwrapCommandOptions = {
  /** 为 true 时不打 console.error */
  quiet?: boolean;
  /** 附加到日志的调试上下文 */
  debugContext?: Record<string, unknown>;
  /** 日志前缀，默认 `[ipc]` */
  logLabel?: string;
};

/**
 * 解包已完成的 CommandResult；失败时抛 Error（含 code/cause）。
 * 兼容 error 为 OmniError 或 string（旧 db/terminal 命令）。
 */
export function unwrapCommandResult<T>(
  res: CommandResult<T, IpcErrorLike>,
  options?: UnwrapCommandOptions,
): T {
  if (res.status === "ok") {
    // data 可能为 null（typedError<null, ...>）
    return res.data as T;
  }
  const label = options?.logLabel ?? "[ipc]";
  if (!options?.quiet) {
    const err = res.error;
    console.error(`${label} IPC error:`, {
      ...options?.debugContext,
      ...(typeof err === "string"
        ? { message: err }
        : {
            code: err.code ?? null,
            message: err.message ?? null,
            cause: err.cause ?? null,
          }),
    });
  }
  throw ipcErrorToError(res.error);
}

/** 解包 Promise 形式的 CommandResult（最常用）。 */
export async function unwrapCommand<T>(
  promise: Promise<CommandResult<T, IpcErrorLike>>,
  options?: UnwrapCommandOptions,
): Promise<T> {
  return unwrapCommandResult(await promise, options);
}

/** @deprecated 使用 formatIpcError；保留别名以兼容 SSH 侧导入。 */
export const formatOmniError = formatIpcError;
