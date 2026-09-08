import type { SubmitPreview } from "../../ipc/bindings";

/** 与确认按钮一致：必须已有预览、钥匙串里已有 token、且未超限。 */
export function canConfirmSubmit(preview: SubmitPreview | null): boolean {
  if (!preview) return false;
  if (preview.waitMs) return false;
  return preview.hasToken;
}
