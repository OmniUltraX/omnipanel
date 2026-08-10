/**
 * `@tauri-apps/api/window` 类型导出（Web shim 的 type-only 兼容）。
 */
export type WindowLabel = string;
export interface CloseRequestedEvent {
  preventDefault: () => void;
  isPreventDefault: () => boolean;
}
