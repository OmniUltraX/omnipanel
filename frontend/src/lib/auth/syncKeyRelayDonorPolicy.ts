import { ipcErrorCode } from "../../ipc/result";

/** 通知通道断开时的兜底间隔。连通后不扫。 */
export const RELAY_FALLBACK_BASE_MS = 3 * 60_000;

/** 认证服务连不上时的退避上限。 */
export const RELAY_FALLBACK_MAX_MS = 10 * 60_000;

/**
 * 连续传输失败越多，下一次兜底越疏。
 * 0 或 1 次失败仍用基础间隔；之后翻倍，到上限为止。
 */
export function nextRelayFallbackDelayMs(failureStreak: number): number {
  const streak = Math.max(0, Math.floor(failureStreak));
  if (streak <= 1) return RELAY_FALLBACK_BASE_MS;
  const scaled = RELAY_FALLBACK_BASE_MS * 2 ** Math.min(streak - 1, 3);
  return Math.min(RELAY_FALLBACK_MAX_MS, scaled);
}

/** 认证服务没连上，或浏览器直连被网络打断。这类失败不提示用户。 */
export function isRelayTransportError(error: unknown): boolean {
  const code = ipcErrorCode(error)?.toLowerCase();
  if (code === "connection" || code === "timeout" || code === "io") return true;
  if (error instanceof Error) {
    return /failed to fetch|network|tcp connect|os error 10060|请求认证服务失败/i.test(
      error.message,
    );
  }
  return false;
}
