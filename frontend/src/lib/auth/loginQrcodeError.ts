/** 把登录二维码请求失败规整为可展示的错误类别（不假设远端服务已恢复）。 */

export type LoginQrcodeErrorKind = "dns" | "timeout" | "network" | "unknown";

export function classifyLoginQrcodeError(error: unknown): LoginQrcodeErrorKind {
  const raw = normalizeLoginQrcodeErrorText(error);
  if (!raw) return "unknown";
  if (
    /无法解析登录服务|dns|failed to lookup|name resolution|nxdomain|resolve host|resolve the host|no such host|not known|nodename nor servname|getaddrinfo|name or service not known/i.test(
      raw,
    )
  ) {
    return "dns";
  }
  if (/获取登录二维码超时|timed?\s*out|timeout|deadline exceeded|operation timed out/i.test(raw)) {
    return "timeout";
  }
  if (
    /connection refused|connect error|error trying to connect|network unreachable|temporarily unavailable|tls|certificate|ssl|connection reset|econnreset|econnrefused|enotfound/i.test(
      raw,
    )
  ) {
    return "network";
  }
  return "unknown";
}

export function normalizeLoginQrcodeErrorText(error: unknown): string {
  if (error == null) return "";
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const rec = error as { message?: unknown; cause?: unknown; code?: unknown };
    const extra: string[] = [];
    if (error instanceof Error) extra.push(error.message);
    else if (rec.message != null) extra.push(String(rec.message));
    if (rec.cause != null && rec.cause !== error) extra.push(String(rec.cause));
    if (rec.code != null) extra.push(String(rec.code));
    if (extra.some((part) => part.trim())) return extra.filter(Boolean).join(" ");
  }
  return String(error);
}

export const LOGIN_QRCODE_ERROR_I18N_KEY: Record<LoginQrcodeErrorKind, string> = {
  dns: "userCenter.login.networkDns",
  timeout: "userCenter.login.networkTimeout",
  network: "userCenter.login.networkUnavailable",
  unknown: "userCenter.login.error",
};
