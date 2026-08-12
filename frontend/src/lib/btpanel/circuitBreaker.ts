import { normalizeBtPanelBaseUrl } from "./auth";
import { BtPanelApiError } from "./types";

type GateEntry = {
  untilMs: number;
  message: string;
};

/** 按面板 origin 熔断，避免并发/重试把「验证失败」打满至封禁。 */
const gates = new Map<string, GateEntry>();

const AUTH_COOLDOWN_MS = 10 * 60 * 1000;

export function btPanelGateKey(baseUrl: string): string {
  try {
    return normalizeBtPanelBaseUrl(baseUrl).toLowerCase();
  } catch {
    return baseUrl.trim().toLowerCase();
  }
}

/** 是否为宝塔临时封禁文案。 */
export function isBtPanelLockoutMessage(message: string): boolean {
  return /连续\s*\d+\s*次验证失败|禁止\s*\d+\s*小时|验证失败.*禁止/i.test(message);
}

/** 鉴权/白名单/封禁类失败（继续请求会加速封禁）。 */
export function isBtPanelAuthFailureMessage(message: string): boolean {
  if (isBtPanelLockoutMessage(message)) return true;
  return /(密钥|校验|验证|权限|白名单|IP校验|unauthorized|api\s*key)/i.test(message);
}

function parseLockoutMs(message: string): number {
  const hours = message.match(/禁止\s*(\d+)\s*小时/i)?.[1];
  if (hours) {
    const n = Number(hours);
    if (Number.isFinite(n) && n > 0) return Math.min(n, 24) * 60 * 60 * 1000;
  }
  const minutes = message.match(/禁止\s*(\d+)\s*分钟/i)?.[1];
  if (minutes) {
    const n = Number(minutes);
    if (Number.isFinite(n) && n > 0) return Math.min(n, 24 * 60) * 60 * 1000;
  }
  return 60 * 60 * 1000;
}

/** 若该面板已熔断，直接抛错且不再发 HTTP。 */
export function assertBtPanelNotLocked(baseUrl: string): void {
  const key = btPanelGateKey(baseUrl);
  const gate = gates.get(key);
  if (!gate) return;
  if (Date.now() >= gate.untilMs) {
    gates.delete(key);
    return;
  }
  throw new BtPanelApiError(gate.message, 0);
}

export function getBtPanelLockout(baseUrl: string): GateEntry | null {
  const key = btPanelGateKey(baseUrl);
  const gate = gates.get(key);
  if (!gate) return null;
  if (Date.now() >= gate.untilMs) {
    gates.delete(key);
    return null;
  }
  return gate;
}

/** 记录鉴权/封禁失败：封禁按提示时长，普通鉴权失败短冷却。 */
export function tripBtPanelAuthFailure(baseUrl: string, rawMessage: string): void {
  const message = rawMessage.trim() || "宝塔 API 鉴权失败";
  if (!isBtPanelAuthFailureMessage(message)) return;

  const key = btPanelGateKey(baseUrl);
  const untilMs = isBtPanelLockoutMessage(message)
    ? Date.now() + parseLockoutMs(message)
    : Date.now() + AUTH_COOLDOWN_MS;

  const existing = gates.get(key);
  if (existing && existing.untilMs >= untilMs) {
    return;
  }
  gates.set(key, { untilMs, message });
}

export function clearBtPanelLockout(baseUrl?: string): void {
  if (!baseUrl) {
    gates.clear();
    return;
  }
  gates.delete(btPanelGateKey(baseUrl));
}

/** 从任意错误对象提取文案并尝试熔断。 */
export function tripBtPanelAuthFailureFromError(baseUrl: string, error: unknown): void {
  const text =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(error ?? "");
  tripBtPanelAuthFailure(baseUrl, text);
}
