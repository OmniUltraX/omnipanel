import type { OmniError_Serialize } from "../../../../ipc/bindings";

/** 将后端 OmniError 格式化为侧栏可读的完整提示 */
export function formatOmniError(error: OmniError_Serialize): string {
  const parts = [error.message];
  if (error.cause?.trim()) {
    parts.push(error.cause.trim());
  }
  return parts.join("：");
}
