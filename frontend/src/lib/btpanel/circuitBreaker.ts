import { normalizeBtPanelBaseUrl } from "./auth";
import { BtPanelApiError } from "./types";

type GateEntry = {
  untilMs: number;
  message: string;
};

/** 按面板 origin 熔断，避免并发/重试把「验证失败」打满至封禁。 */
const gates = new Map<string, GateEntry>();

const AUTH_COOLDOWN_MS = 15 * 1000;

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

/** 记录鉴权/封禁失败：封禁按提示时长；普通密钥/IP 失败仅短冷却，避免挡住用户改密钥重试。 */
export function tripBtPanelAuthFailure(baseUrl: string, rawMessage: string): void {
  const message = enrichBtPanelAuthMessage(rawMessage.trim() || "宝塔 API 鉴权失败");
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

/** 补全密钥/IP 失败提示，避免用户误以为「密钥错了」而反复粘贴。 */
export function enrichBtPanelAuthMessage(msg: string): string {
  const trimmed = msg.trim();
  if (!trimmed) return "宝塔 API 鉴权失败";

  const ipMatch = trimmed.match(/IP校验失败[^[]*\[([^\]]+)\]/i);
  if (ipMatch || /IP校验失败|IP.?校验|IP.?白名单/i.test(trimmed)) {
    const ip = ipMatch?.[1]?.trim();
    const ipHint = ip ? `当前访问 IP：${ip}。` : "";
    return (
      `${trimmed}。${ipHint}` +
      "请到宝塔「面板设置 → API 接口」将本机出口 IP 加入白名单（可临时填 *），保存后再试。"
    );
  }

  if (/密钥校验失败|接口密钥错误|API\s*接口密钥错误/i.test(trimmed)) {
    return (
      `${trimmed}。` +
      "若密钥确认无误，请检查：① 面板地址是否为 https://主机:端口；② IP 白名单是否包含本机出口 IP（可临时填 *）；③ 是否刚触发过验证失败熔断（请等待数秒后重试）。"
    );
  }

  if (/连续\s*\d+\s*次验证失败|禁止\s*\d+\s*小时|验证失败.*禁止/i.test(trimmed)) {
    return (
      `${trimmed}。` +
      "这是宝塔侧临时封禁。请确认 API 已开启、密钥正确、IP 白名单已放行，并等待封禁时长结束；期间请勿反复点测试。"
    );
  }

  return trimmed;
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
