/**
 * omniserver HTTP：优先经 IPC 后端代理（避免打包 WebView CORS → Failed to fetch），
 * 无 IPC 时回退浏览器直连（仅开发态裸浏览器）。
 */
import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { canUseIpcBackend } from "../isTauriRuntime";

const AUTH_ASSET_BASE = "https://mp.99.protected.fun";

export type AuthOmniFetchInit = RequestInit & {
  deviceId?: string;
  appId?: string;
};

export async function authOmniFetch(
  token: string,
  path: string,
  init?: AuthOmniFetchInit,
): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  const rawBody = init?.body;
  const body =
    typeof rawBody === "string"
      ? rawBody
      : rawBody != null
        ? String(rawBody)
        : null;

  if (canUseIpcBackend() && typeof commands.authApiRequest === "function") {
    const result = await unwrapCommand(
      commands.authApiRequest(
        token,
        method,
        path,
        body,
        init?.deviceId?.trim() || null,
        init?.appId?.trim() || null,
      ),
    );
    const headers = new Headers();
    if (result.contentType) {
      headers.set("Content-Type", result.contentType);
    }
    return new Response(result.body, { status: result.status, headers });
  }

  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("X-App-Id", init?.appId ?? "omni-client");
  if (init?.deviceId) headers.set("X-Device-Id", init.deviceId);
  if (body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const { deviceId: _deviceId, appId: _appId, ...rest } = init ?? {};
  return fetch(`${AUTH_ASSET_BASE}${path}`, { ...rest, method, headers, body });
}
