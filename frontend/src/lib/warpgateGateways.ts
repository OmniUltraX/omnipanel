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

export type WarpgateSshTarget = {
  id: string;
  name: string;
  kind: string;
  bastionHost: string;
  bastionPort: number;
  loginUser?: string;
};

type TargetCacheEntry = {
  targets: WarpgateSshTarget[];
  fetchedAt: number;
};

type WarpgatePluginState = {
  gateways: WarpgateGateway[];
  /** 按网关缓存的 SSH Target 列表，避免每次打开表单都打 API */
  targetCache?: Record<string, TargetCacheEntry>;
  [key: string]: unknown;
};

/** 进程内缓存，减少反复读 pluginState */
const memoryTargetCache = new Map<string, WarpgateSshTarget[]>();

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

function normalizeTarget(raw: unknown): WarpgateSshTarget | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id.trim()) return null;
  return {
    id: item.id,
    name: typeof item.name === "string" ? item.name : item.id,
    kind: typeof item.kind === "string" ? item.kind : "ssh",
    bastionHost: typeof item.bastionHost === "string" ? item.bastionHost : "",
    bastionPort: typeof item.bastionPort === "number" ? item.bastionPort : 2222,
    loginUser: typeof item.loginUser === "string" ? item.loginUser : undefined,
  };
}

async function loadPluginState(): Promise<WarpgatePluginState> {
  try {
    const raw = await unwrapCommand(commands.pluginStateGet(PLUGIN_ID_WARPGATE));
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { gateways: [] };
    }
    return parsed as WarpgatePluginState;
  } catch {
    return { gateways: [] };
  }
}

async function savePluginState(state: WarpgatePluginState): Promise<void> {
  await unwrapCommand(commands.pluginStateSet(PLUGIN_ID_WARPGATE, JSON.stringify(state)));
}

function readTargetCacheFromState(
  state: WarpgatePluginState,
  gatewayId: string,
): WarpgateSshTarget[] | null {
  const entry = state.targetCache?.[gatewayId];
  if (!entry || !Array.isArray(entry.targets)) return null;
  return entry.targets
    .map(normalizeTarget)
    .filter((item): item is WarpgateSshTarget => item !== null);
}

export async function loadWarpgateGateways(): Promise<WarpgateGateway[]> {
  const state = await loadPluginState();
  return Array.isArray(state.gateways)
    ? state.gateways.map(normalizeGateway).filter((g): g is WarpgateGateway => g !== null)
    : [];
}

async function saveGateways(gateways: WarpgateGateway[]): Promise<void> {
  const state = await loadPluginState();
  await savePluginState({ ...state, gateways });
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
  // 凭据/地址可能变化，清掉该网关 Target 缓存
  await invalidateWarpgateTargetCache(id);
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
  await invalidateWarpgateTargetCache(id);
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

async function persistTargetCache(
  gatewayId: string,
  targets: WarpgateSshTarget[],
): Promise<void> {
  memoryTargetCache.set(gatewayId, targets);
  const state = await loadPluginState();
  const targetCache = { ...(state.targetCache ?? {}) };
  targetCache[gatewayId] = { targets, fetchedAt: Date.now() };
  await savePluginState({ ...state, targetCache });
}

/** 清除指定网关（或全部）的 Target 本地缓存。 */
export async function invalidateWarpgateTargetCache(gatewayId?: string): Promise<void> {
  if (gatewayId) {
    memoryTargetCache.delete(gatewayId);
  } else {
    memoryTargetCache.clear();
  }
  const state = await loadPluginState();
  if (!state.targetCache) return;
  if (!gatewayId) {
    const { targetCache: _removed, ...rest } = state;
    await savePluginState({ ...rest, gateways: state.gateways ?? [] });
    return;
  }
  const targetCache = { ...state.targetCache };
  delete targetCache[gatewayId];
  await savePluginState({ ...state, targetCache });
}

/**
 * 列出网关下 SSH Target。
 * 默认读本地缓存（pluginState + 内存）；`force: true` 时强制打 API 并回写缓存。
 */
export async function listWarpgateSshTargets(
  gateway: WarpgateGateway,
  opts?: { force?: boolean },
): Promise<WarpgateSshTarget[]> {
  const force = Boolean(opts?.force);
  if (!force) {
    const mem = memoryTargetCache.get(gateway.id);
    if (mem) return mem;
    const state = await loadPluginState();
    const cached = readTargetCacheFromState(state, gateway.id);
    if (cached) {
      memoryTargetCache.set(gateway.id, cached);
      return cached;
    }
  }

  const payload = await invokeWarpgateMethod<{ targets?: WarpgateSshTarget[] }>(
    "listSshTargets",
    gateway,
  );
  const targets = Array.isArray(payload.targets)
    ? payload.targets
        .map(normalizeTarget)
        .filter((item): item is WarpgateSshTarget => item !== null)
    : [];
  await persistTargetCache(gateway.id, targets);
  return targets;
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
