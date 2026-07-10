import { isTauriRuntime } from "./isTauriRuntime";



/** Tauri 桌面端启用跨窗拖拽；document 级监听在拖拽开始时懒挂载 */

export function isCrossWindowDragRuntime(): boolean {

  return isTauriRuntime();

}



/** @deprecated 使用 isCrossWindowDragRuntime */

export async function shouldEnableCrossWindowDrag(): Promise<boolean> {

  return isCrossWindowDragRuntime();

}


