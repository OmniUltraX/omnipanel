/**
 * `@tauri-apps/api/event` 类型导出（Web shim 的 type-only 兼容）。
 */
export type EventName = string;
export type UnlistenFn = () => void;
export type EventCallback<T> = (event: { event: string; id: number; payload: T }) => void;
export type EventTarget = string | { kind: string; label?: string };
