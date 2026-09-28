import { commands, type SshConfig_Deserialize } from "../ipc/bindings";
import { formatIpcError } from "../ipc/result";
import { showToast } from "../stores/toastStore";
import { useConnectionStore } from "../stores/connectionStore";
import {
  parseSshConfig,
  type SshFallbackRoute,
  type SshPreferredRoute,
} from "../modules/server/panel/serverConnection";
import {
  isWarpgatePluginReady,
  loadWarpgateGateways,
  PLUGIN_ID_WARPGATE,
  resolveWarpgateSshRoute,
} from "./warpgateGateways";

/** 单次连接覆盖：打开终端前设置，消费后清除。 */
export type SshRouteOverride = "auto" | "direct" | string;

const routeOverrides = new Map<string, SshRouteOverride>();

export function setSshRouteOverride(connectionId: string, route: SshRouteOverride | null): void {
  if (!route) routeOverrides.delete(connectionId);
  else routeOverrides.set(connectionId, route);
}

export function takeSshRouteOverride(connectionId: string): SshRouteOverride | null {
  const value = routeOverrides.get(connectionId) ?? null;
  if (value != null) routeOverrides.delete(connectionId);
  return value;
}

function sortedFallbacks(list: SshFallbackRoute[] | undefined): SshFallbackRoute[] {
  if (!Array.isArray(list) || list.length === 0) return [];
  return [...list]
    .filter((item) => item.pluginId === PLUGIN_ID_WARPGATE && item.gatewayId && item.targetId)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function resolveChoice(
  override: SshRouteOverride | null,
  preferred: SshPreferredRoute | undefined,
): SshRouteOverride {
  if (override) return override;
  if (preferred === "direct" || preferred === "auto") return preferred;
  if (typeof preferred === "string" && preferred.trim()) return preferred.trim();
  return "auto";
}

async function connectDirect(
  connectionId: string,
  cols: number,
  rows: number,
  paneId: number | null,
): Promise<string> {
  const res = await commands.sshConnectConnection(connectionId, cols, rows, paneId);
  if (res.status === "ok") return res.data;
  throw res.error ?? new Error("SSH 直连失败");
}

async function connectViaFallback(
  fallback: SshFallbackRoute,
  cols: number,
  rows: number,
  paneId: number | null,
): Promise<string> {
  if (!isWarpgatePluginReady()) {
    throw new Error("Warpgate 插件未启用");
  }
  const gateways = await loadWarpgateGateways();
  const gateway = gateways.find((g) => g.id === fallback.gatewayId);
  if (!gateway) {
    throw new Error(`未找到 Warpgate 网关（${fallback.gatewayId}）`);
  }
  const resolved = await resolveWarpgateSshRoute(gateway, {
    targetId: fallback.targetId,
    targetName: fallback.targetName,
  });
  const password = String(resolved.password ?? "").trim();
  if (!password) {
    throw new Error("Warpgate 网关未配置登录密码，无法经堡垒连接");
  }
  const config = {
    host: resolved.host,
    port: resolved.port || 2222,
    user: resolved.user,
    auth: { type: "password" as const, password },
  } as unknown as SshConfig_Deserialize;
  const res = await commands.sshConnect(config, cols, rows, paneId);
  if (res.status === "ok") return res.data;
  throw res.error ?? new Error("经 Warpgate 备选连接失败");
}

/**
 * SSH 会话建立：支持直连 / 指定备选 / 自动降级（直连失败后按 order 试备选）。
 */
export async function connectSshWithFallbacks(
  connectionId: string,
  cols: number,
  rows: number,
  paneId: number | null,
): Promise<string> {
  const override = takeSshRouteOverride(connectionId);
  const conn = useConnectionStore.getState().connections.find((c) => c.id === connectionId);
  const cfg = conn ? parseSshConfig(conn) : null;
  const fallbacks = sortedFallbacks(cfg?.fallbacks);
  const choice = resolveChoice(override, cfg?.preferredRoute);

  if (choice === "direct") {
    return connectDirect(connectionId, cols, rows, paneId);
  }

  if (choice !== "auto") {
    const fb = fallbacks.find((item) => item.id === choice);
    if (!fb) throw new Error("指定的备选连接不存在");
    return connectViaFallback(fb, cols, rows, paneId);
  }

  if (fallbacks.length === 0 || !isWarpgatePluginReady()) {
    return connectDirect(connectionId, cols, rows, paneId);
  }

  try {
    return await connectDirect(connectionId, cols, rows, paneId);
  } catch (directErr) {
    let lastErr: unknown = directErr;
    for (const fb of fallbacks) {
      try {
        const sid = await connectViaFallback(fb, cols, rows, paneId);
        const label = fb.label?.trim() || fb.targetName || fb.targetId;
        showToast(`直连失败，已改用 Warpgate 备选：${label}`);
        return sid;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(formatIpcError(lastErr));
  }
}
