/**
 * `@tauri-apps/api/core` 类型导出（Web shim 的 type-only 兼容）。
 */
export type InvokeArgs = Record<string, unknown> | number[] | ArrayBuffer | Uint8Array;
export interface InvokeOptions {
  headers: HeadersInit;
}
