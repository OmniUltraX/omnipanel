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

    // 流被对端/代理断开：可刷新二维码恢复，不当作硬错误刷屏
    if (
      code === "timeout" ||
      message.includes("已断开") ||
      message.includes("已结束") ||
      message.includes("decoding response body") ||
      message.includes("读取登录等待流失败")
    ) {
      throw Object.assign(new Error(message), { code: "timeout", name: "LoginWaitDisconnected" });
    }

    console.error("[auth] login wait failed:", {
      loginId,
      message,
      code,
    });
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
export async function fetchDevices(token: string): Promise<AuthDevice[]> {
  return unwrapCommand(commands.authListDevices(token));
}

export interface AuthUserProfile {
  id: number;
  openid: string;
  nickname: string;
  avatarUrl: string;
  email: string;
}

/** 经 Tauri 后端代理拉取当前用户资料（GET /api/me）。 */
export async function fetchMe(token: string): Promise<AuthUserProfile> {
  const data = await unwrapCommand(commands.authGetMe(token));
  return {
    id: data.id,
    openid: data.openid,
    nickname: data.nickname,
    avatarUrl: data.avatarUrl,
    email: data.email,
  };
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
  return {
    id: data.id,
    openid: data.openid,
    nickname: data.nickname,
    avatarUrl: data.avatarUrl,
    email: data.email,
  };
}

export function isAuthSessionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "auth" || code === "Auth";
}
