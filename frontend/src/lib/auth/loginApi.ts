import { commands } from "../../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../../ipc/result";

export interface LoginQrcodeResponse {
  login_id: string;
  scene: string;
  ticket: string;
  qrcode_url: string;
  expire_in_sec: number;
}

export interface LoginSuccessPayload {
  token: string;
  openid: string;
}

export interface EmailCodeSent {
  email: string;
  code: string;
  expireInSec: number;
  hint: string;
}

export interface DeviceIdentity {
  deviceId: string;
  deviceName: string;
  osType: string;
}

export interface AuthDevice {
  id: number;
  deviceId: string;
  deviceName: string;
  osType: string;
  ip: string;
  lastLoginAt: string;
  userAgent: string;
  createdAt: string;
  updatedAt: string;
  /** `client` | `assistant` */
  role: string;
  appId: string;
}

export interface BindingsQrcodeResponse {
  bind_id: string;
  qr_payload: string;
  expire_in_sec: number;
}

/** 经 Tauri 后端代理获取登录二维码（绕过 WebView CORS）。 */
export async function fetchLoginQrcode(_signal?: AbortSignal): Promise<LoginQrcodeResponse> {
  const data = await unwrapCommand(commands.authLoginQrcode());
  return {
    login_id: data.loginId,
    scene: data.scene,
    ticket: data.ticket,
    qrcode_url: data.qrcodeUrl,
    expire_in_sec: data.expireInSec,
  };
}

/** 发送邮箱登录验证码。开发模式响应可能直接带 `code`。 */
export async function sendEmailLoginCode(email: string): Promise<EmailCodeSent> {
  return unwrapCommand(commands.authLoginEmailSend(email));
}

/** 邮箱验证码登录。 */
export async function loginWithEmail(email: string, code: string): Promise<LoginSuccessPayload> {
  const data = await unwrapCommand(commands.authLoginEmail(email, code));
  return { token: data.token, openid: data.openid };
}

/** GitHub OAuth 登录（系统浏览器 + 本机回环接收 token）。 */
export async function loginWithGithub(): Promise<LoginSuccessPayload> {
  try {
    const data = await unwrapCommand(commands.authLoginGithub());
    return { token: data.token, openid: data.openid };
  } catch (error) {
    const message = error instanceof Error ? error.message : formatIpcError(error as never);
    if (message.includes("已取消")) {
      throw new DOMException("Aborted", "AbortError");
    }
    throw error instanceof Error ? error : new Error(message);
  }
}

/** 取消进行中的 GitHub 登录等待。 */
export async function cancelGithubLogin(): Promise<void> {
  await unwrapCommand(commands.authLoginGithubCancel(), { quiet: true }).catch(() => {});
}

export interface AccountLinkStatus {
  bound: boolean;
  openid: string;
  githubId: string;
  email: string;
}

export interface AccountLinks {
  wechat: AccountLinkStatus;
  github: AccountLinkStatus;
  email: AccountLinkStatus;
}

/** 查询账号绑定状态。 */
export async function fetchAccountLinks(
  token: string,
  options?: { quiet?: boolean },
): Promise<AccountLinks> {
  return unwrapCommand(commands.authAccountLinks(token), {
    quiet: options?.quiet,
    logLabel: "[auth]",
  });
}

/** 申请微信绑定二维码。 */
export async function fetchWechatLinkQrcode(token: string): Promise<LoginQrcodeResponse> {
  const data = await unwrapCommand(commands.authLinkWechatQrcode(token));
  return {
    login_id: data.loginId,
    scene: data.scene,
    ticket: data.ticket,
    qrcode_url: data.qrcodeUrl,
    expire_in_sec: data.expireInSec,
  };
}

/**
 * SSE 等待微信账号绑定。
 * abort 时调用 authLinkWechatCancelWait。
 */
export async function waitForWechatLink(
  token: string,
  loginId: string,
  options?: { signal?: AbortSignal; expireInSec?: number },
): Promise<void> {
  const onAbort = () => {
    void unwrapCommand(commands.authLinkWechatCancelWait(loginId), { quiet: true }).catch(
      () => {},
    );
  };

  if (options?.signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  options?.signal?.addEventListener("abort", onAbort);

  try {
    await unwrapCommand(
      commands.authLinkWechatWait(token, loginId, options?.expireInSec ?? null),
      { quiet: true },
    );
  } catch (error) {
    if (options?.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const message = error instanceof Error ? error.message : formatIpcError(error as never);
    const code =
      error instanceof Error ? ((error as Error & { code?: string }).code ?? null) : null;

    if (message.includes("已取消")) {
      throw new DOMException("Aborted", "AbortError");
    }

    if (
      code === "timeout" ||
      message.includes("已断开") ||
      message.includes("已结束") ||
      message.includes("decoding response body") ||
      message.includes("读取微信绑定等待流失败")
    ) {
      throw Object.assign(new Error(message), {
        code: "timeout",
        name: "WechatLinkWaitDisconnected",
      });
    }

    throw error instanceof Error ? error : new Error(message);
  } finally {
    options?.signal?.removeEventListener("abort", onAbort);
  }
}

/** 发送邮箱绑定验证码。 */
export async function sendEmailLinkCode(
  token: string,
  email: string,
): Promise<EmailCodeSent> {
  return unwrapCommand(commands.authLinkEmailSend(token, email));
}

/** 邮箱验证码绑定账号。 */
export async function linkEmail(
  token: string,
  email: string,
  code: string,
): Promise<AuthUserProfile> {
  const data = await unwrapCommand(commands.authLinkEmail(token, email, code));
  return mapUserProfile(data);
}

/** GitHub OAuth 绑定（系统浏览器授权，轮询绑定状态）。 */
export async function linkGithub(token: string): Promise<void> {
  try {
    await unwrapCommand(commands.authLinkGithub(token), { quiet: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : formatIpcError(error as never);
    if (message.includes("已取消")) {
      throw new DOMException("Aborted", "AbortError");
    }
    throw error instanceof Error ? error : new Error(message);
  }
}

/** 取消进行中的 GitHub 绑定等待。 */
export async function cancelGithubLink(): Promise<void> {
  await unwrapCommand(commands.authLinkGithubCancel(), { quiet: true }).catch(() => {});
}

/** 解绑微信。 */
export async function unlinkWechat(token: string): Promise<AuthUserProfile> {
  const data = await unwrapCommand(commands.authUnlinkWechat(token));
  return mapUserProfile(data);
}

/** 解绑 GitHub。 */
export async function unlinkGithub(token: string): Promise<AuthUserProfile> {
  const data = await unwrapCommand(commands.authUnlinkGithub(token));
  return mapUserProfile(data);
}

/** 解绑邮箱。 */
export async function unlinkEmail(token: string): Promise<AuthUserProfile> {
  const data = await unwrapCommand(commands.authUnlinkEmail(token));
  return mapUserProfile(data);
}

/**
 * 经 Tauri 后端代理 SSE 等待扫码登录。
 * abort 时会调用 authLoginCancelWait 打断后端连接。
 */
export async function waitForLogin(
  loginId: string,
  options?: { signal?: AbortSignal; expireInSec?: number },
): Promise<LoginSuccessPayload> {
  const onAbort = () => {
    void unwrapCommand(commands.authLoginCancelWait(loginId), { quiet: true }).catch(() => {});
  };

  if (options?.signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  options?.signal?.addEventListener("abort", onAbort);

  try {
    // 取消等待是预期路径（切 Tab / 刷新二维码 / 卸载），勿打 console.error
    const data = await unwrapCommand(
      commands.authLoginWait(loginId, options?.expireInSec ?? null),
      { quiet: true },
    );
    return {
      token: data.token,
      openid: data.openid,
    };
  } catch (error) {
    if (options?.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const message = error instanceof Error ? error.message : formatIpcError(error as never);
    const code =
      error instanceof Error ? ((error as Error & { code?: string }).code ?? null) : null;

    // 主动取消
    if (message.includes("已取消")) {
      throw new DOMException("Aborted", "AbortError");
    }

    // 流被对端/代理断开：可刷新二维码恢复
    if (
      code === "timeout" ||
      message.includes("已断开") ||
      message.includes("已结束") ||
      message.includes("decoding response body") ||
      message.includes("读取登录等待流失败")
    ) {
      throw Object.assign(new Error(message), { code: "timeout", name: "LoginWaitDisconnected" });
    }

    throw error instanceof Error ? error : new Error(message);
  } finally {
    options?.signal?.removeEventListener("abort", onAbort);
  }
}

/** 读取本机设备身份（登录上报与「本机」标记共用）。 */
export async function fetchDeviceIdentity(): Promise<DeviceIdentity> {
  return unwrapCommand(commands.authDeviceIdentity());
}

/** 经 Tauri 后端代理拉取当前用户设备列表。 */
export async function fetchDevices(
  token: string,
  options?: { quiet?: boolean },
): Promise<AuthDevice[]> {
  return unwrapCommand(commands.authListDevices(token), {
    quiet: options?.quiet,
    logLabel: "[auth]",
  });
}

/** 经 Tauri 后端代理删除设备（DELETE /api/devices/{device_id}）。 */
export async function deleteDevice(token: string, deviceId: string): Promise<void> {
  await unwrapCommand(commands.authDeleteDevice(token, deviceId));
}

/** 申请绑定助手端二维码 payload（本地画码）。 */
export async function fetchBindingsQrcode(token: string): Promise<BindingsQrcodeResponse> {
  const data = await unwrapCommand(commands.authBindingsQrcode(token));
  return {
    bind_id: data.bindId,
    qr_payload: data.qrPayload,
    expire_in_sec: data.expireInSec,
  };
}

/**
 * 经 Tauri 后端代理 SSE 等待助手端扫码确认绑定。
 * abort 时会调用 authBindingsCancelWait 打断后端连接。
 */
export async function waitForBindings(
  token: string,
  bindId: string,
  options?: { signal?: AbortSignal; expireInSec?: number },
): Promise<void> {
  const onAbort = () => {
    void unwrapCommand(commands.authBindingsCancelWait(bindId), { quiet: true }).catch(() => {});
  };

  if (options?.signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  options?.signal?.addEventListener("abort", onAbort);

  try {
    await unwrapCommand(
      commands.authBindingsWait(token, bindId, options?.expireInSec ?? null),
      { quiet: true },
    );
  } catch (error) {
    if (options?.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const message = error instanceof Error ? error.message : formatIpcError(error as never);
    const code =
      error instanceof Error ? ((error as Error & { code?: string }).code ?? null) : null;

    if (message.includes("已取消")) {
      throw new DOMException("Aborted", "AbortError");
    }

    if (
      code === "timeout" ||
      message.includes("已断开") ||
      message.includes("已结束") ||
      message.includes("decoding response body") ||
      message.includes("读取绑定等待流失败")
    ) {
      throw Object.assign(new Error(message), { code: "timeout", name: "BindingsWaitDisconnected" });
    }

    throw error instanceof Error ? error : new Error(message);
  } finally {
    options?.signal?.removeEventListener("abort", onAbort);
  }
}

export interface AuthUserProfile {
  id: number;
  openid: string;
  nickname: string;
  avatarUrl: string;
  email: string;
  githubId: string;
}

const AUTH_ASSET_BASE = "https://mp.99.protected.fun";

/** 将接口返回的 avatar_url（相对路径或绝对 URL）规范为可展示地址。 */
export function resolveAvatarUrl(url: string | null | undefined): string {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return "";
  if (/^(data:|https?:|blob:|asset:)/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (trimmed.startsWith("/")) return `${AUTH_ASSET_BASE}${trimmed}`;
  return `${AUTH_ASSET_BASE}/${trimmed}`;
}

function mapUserProfile(data: {
  id: number | null;
  openid: string;
  nickname: string;
  avatarUrl?: string;
  avatar_url?: string;
  email: string;
  githubId?: string;
  github_id?: string;
}): AuthUserProfile {
  const rawAvatar =
    (typeof data.avatarUrl === "string" && data.avatarUrl) ||
    (typeof data.avatar_url === "string" && data.avatar_url) ||
    "";
  const githubId =
    (typeof data.githubId === "string" && data.githubId) ||
    (typeof data.github_id === "string" && data.github_id) ||
    "";
  return {
    id: data.id ?? 0,
    openid: data.openid ?? "",
    nickname: data.nickname,
    avatarUrl: resolveAvatarUrl(rawAvatar),
    email: data.email ?? "",
    githubId,
  };
}

/** 经 Tauri 后端代理拉取当前用户资料（GET /api/me）。 */
export async function fetchMe(
  token: string,
  options?: { quiet?: boolean },
): Promise<AuthUserProfile> {
  const data = await unwrapCommand(commands.authGetMe(token), {
    quiet: options?.quiet,
    logLabel: "[auth]",
  });
  return mapUserProfile(data);
}

/** 经 Tauri 后端代理更新当前用户资料（PATCH /api/me）。 */
export async function updateProfile(
  token: string,
  patch: { nickname?: string; avatarUrl?: string },
): Promise<AuthUserProfile> {
  const data = await unwrapCommand(
    commands.authUpdateProfile(
      token,
      patch.nickname ?? null,
      patch.avatarUrl ?? null,
    ),
  );
  return mapUserProfile(data);
}

export function isAuthSessionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code !== "auth" && code !== "Auth") return false;
  const message = String((error as { message?: unknown }).message ?? "");
  const cause = String((error as { cause?: unknown }).cause ?? "");
  const text = `${message}\n${cause}`;
  // 仅真正会话失效才登出；绑定冲突 / 用户取消等业务 Auth 错误不踢登录
  return /登录已失效|缺少登录凭证|missing token|unauthorized|session expired|凭证无效|未登录/i.test(
    text,
  );
}
