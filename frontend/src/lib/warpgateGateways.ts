import { commands } from "../ipc/bindings";
import { unwrapCommand } from "../ipc/result";
import { isPluginActivated } from "../stores/pluginRuntimeStore";

export const PLUGIN_ID_WARPGATE = "omni.addon.warpgate";

export type WarpgateGateway = {
  id: string;
  name: string;
  baseUrl: string;
  loginUser: string;
  insecureTls: boolean;
  tokenKey: string;
  passwordKey: string;
  updatedAt: number;
};

type WarpgatePluginState = {
  gateways: WarpgateGateway[];
};

export function newWarpgateGatewayId(): string {
  return `wg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function isWarpgatePluginReady(): boolean {
  return isPluginActivated(PLUGIN_ID_WARPGATE);
}

function normalizeGateway(raw: unknown): WarpgateGateway | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id.trim()) return null;
  if (typeof item.baseUrl !== "string" || !item.baseUrl.trim()) return null;
  return {
    id: item.id,
    name: typeof item.name === "string" ? item.name : "",
    baseUrl: item.baseUrl.trim().replace(/\/+$/, ""),
    loginUser: typeof item.loginUser === "string" ? item.loginUser : "",
    insecureTls: item.insecureTls !== false && item.insecureTls !== "false",
    tokenKey: typeof item.tokenKey === "string" && item.tokenKey ? item.tokenKey : `token-${item.id}`,
    passwordKey:
      typeof item.passwordKey === "string" && item.passwordKey
        ? item.passwordKey
        : `login-${item.id}`,
    updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : Date.now(),
  };
}

export async function loadWarpgateGateways(): Promise<WarpgateGateway[]> {
  const raw = await unwrapCommand(commands.pluginStateGet(PLUGIN_ID_WARPGATE));
  try {
    const parsed = JSON.parse(raw) as { gateways?: unknown[] };
    return Array.isArray(parsed.gateways)
      ? parsed.gateways.map(normalizeGateway).filter((g): g is WarpgateGateway => g !== null)
      : [];
  } catch {
    return [];
  }
}

async function saveGateways(gateways: WarpgateGateway[]): Promise<void> {
  const state: WarpgatePluginState = { gateways };
  await unwrapCommand(commands.pluginStateSet(PLUGIN_ID_WARPGATE, JSON.stringify(state)));
}

export async function upsertWarpgateGateway(input: {
  id?: string;
  name: string;
  baseUrl: string;
  loginUser: string;
  insecureTls: boolean;
  token?: string;
  password?: string;
}): Promise<WarpgateGateway> {
  const list = await loadWarpgateGateways();
  const id = input.id?.trim() || newWarpgateGatewayId();
  const existing = list.find((g) => g.id === id);
  const tokenKey = existing?.tokenKey ?? `token-${id}`;
  const passwordKey = existing?.passwordKey ?? `login-${id}`;
  const token = input.token?.trim() ?? "";
  const password = input.password?.trim() ?? "";
  if (token) {
    await unwrapCommand(commands.pluginSecretPut(PLUGIN_ID_WARPGATE, tokenKey, token));
  } else if (!existing) {
    throw new Error("请填写 API Token");
  }
  if (password) {
    await unwrapCommand(commands.pluginSecretPut(PLUGIN_ID_WARPGATE, passwordKey, password));
  }
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  const next: WarpgateGateway = {
    id,
    name: input.name.trim() || hostLabel(baseUrl) || id,
    baseUrl,
    loginUser: input.loginUser.trim(),
    insecureTls: input.insecureTls,
    tokenKey,
    passwordKey,
    updatedAt: Date.now(),
  };
  const gateways = existing ? list.map((g) => (g.id === id ? next : g)) : [...list, next];
  await saveGateways(gateways);
  return next;
}

export async function deleteWarpgateGateway(id: string): Promise<void> {
  const list = await loadWarpgateGateways();
  const target = list.find((g) => g.id === id);
  if (target) {
    await unwrapCommand(commands.pluginSecretDelete(PLUGIN_ID_WARPGATE, target.tokenKey)).catch(
      () => undefined,
    );
    await unwrapCommand(commands.pluginSecretDelete(PLUGIN_ID_WARPGATE, target.passwordKey)).catch(
      () => undefined,
    );
  }
  await saveGateways(list.filter((g) => g.id !== id));
}

export async function readWarpgateSecret(
  gateway: WarpgateGateway,
  which: "token" | "password",
): Promise<string> {
  const key = which === "token" ? gateway.tokenKey : gateway.passwordKey;
  try {
    return await unwrapCommand(commands.pluginSecretGet(PLUGIN_ID_WARPGATE, key));
  } catch {
    return "";
  }
}

export type WarpgateSshTarget = {
  id: string;
  name: string;
  kind: string;
  bastionHost: string;
  bastionPort: number;
  loginUser?: string;
};

export async function invokeWarpgateMethod<T>(
  method: string,
  gateway: WarpgateGateway,
  extra?: Record<string, unknown>,
): Promise<T> {
  const token = await readWarpgateSecret(gateway, "token");
  const password = await readWarpgateSecret(gateway, "password");
  const args: Record<string, unknown> = {
    baseUrl: gateway.baseUrl,
    loginUser: gateway.loginUser,
    insecureTls: gateway.insecureTls,
    token,
    tokenKey: gateway.tokenKey,
    password,
    passwordKey: gateway.passwordKey,
    ...(extra ?? {}),
  };
  return (await unwrapCommand(
    commands.pluginInvoke(PLUGIN_ID_WARPGATE, method, args as never),
  )) as T;
}

export async function listWarpgateSshTargets(
  gateway: WarpgateGateway,
): Promise<WarpgateSshTarget[]> {
  const payload = await invokeWarpgateMethod<{ targets?: WarpgateSshTarget[] }>(
    "listSshTargets",
    gateway,
  );
  return Array.isArray(payload.targets) ? payload.targets : [];
}

export type ResolvedWarpgateSsh = {
  host: string;
  port: number;
  user: string;
  password?: string;
  targetId?: string;
  targetName?: string;
};

export async function resolveWarpgateSshRoute(
  gateway: WarpgateGateway,
  target: { targetId?: string; targetName?: string },
): Promise<ResolvedWarpgateSsh> {
  return invokeWarpgateMethod<ResolvedWarpgateSsh>("resolveSshViaGateway", gateway, {
    targetId: target.targetId ?? "",
    targetName: target.targetName ?? "",
  });
}

function hostLabel(value: string): string {
  try {
    return new URL(value).host || value;
  } catch {
    return value;
  }
}
