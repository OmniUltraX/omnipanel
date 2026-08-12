import { formatIpcError } from "../../../ipc/result";

/** Redis key 详情/操作返回的 key 不存在（TYPE=none / TTL=-2 等）。 */
export function isRedisKeyNotFoundError(error: unknown): boolean {
  if (error instanceof Error) {
    const code = (error as Error & { code?: string }).code;
    if (code === "notFound") {
      return true;
    }
    const message = error.message;
    return message.includes("Key 不存在") || /key.*not found/i.test(message);
  }
  if (typeof error === "string") {
    return error.includes("Key 不存在") || /key.*not found/i.test(error);
  }
  if (error && typeof error === "object") {
    const record = error as { code?: string; message?: string };
    if (record.code === "notFound") {
      return true;
    }
    const message = record.message ?? "";
    return message.includes("Key 不存在") || /key.*not found/i.test(message);
  }
  return false;
}

export function formatRedisKeyDetailError(error: unknown): string {
  return formatIpcError(error);
}
