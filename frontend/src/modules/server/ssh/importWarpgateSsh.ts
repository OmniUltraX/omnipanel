import type { Connection } from "../../../ipc/bindings";
import { useConnectionStore } from "../../../stores/connectionStore";
import {
  PLUGIN_ID_WARPGATE,
  loadWarpgateGateways,
  listWarpgateSshTargets,
  resolveWarpgateSshRoute,
  type WarpgateGateway,
  type WarpgateSshTarget,
} from "../../../lib/warpgateGateways";
import { parseSshConfig, type SshFallbackRoute } from "../panel/serverConnection";

export type WarpgateImportPick = {
  gatewayId: string;
  targetId: string;
  targetName: string;
};

export type WarpgateImportResult = {
  added: number;
  updated: number;
  skipped: number;
  failures: string[];
  /** 本次新增或更新的连接 id */
  savedIds: string[];
};

export type WarpgateImportRow = {
  key: string;
  gateway: WarpgateGateway;
  target: WarpgateSshTarget;
};

export function warpgateImportKey(gatewayId: string, targetId: string): string {
  return `${gatewayId}::${targetId}`;
}

function findExistingByWarpgate(
  connections: Connection[],
  gatewayId: string,
  targetId: string,
  targetName: string,
): Connection | undefined {
  for (const conn of connections) {
    if (conn.kind !== "ssh") continue;
    const cfg = parseSshConfig(conn);
    if (!cfg) continue;
    const hit = (cfg.fallbacks ?? []).some(
      (fb) =>
        fb.pluginId === PLUGIN_ID_WARPGATE &&
        fb.gatewayId === gatewayId &&
        (fb.targetId === targetId || fb.targetName === targetName),
    );
    if (hit) return conn;
    // 历史导入：名称与 target 一致且主机落在堡垒上
    if (conn.name === targetName) return conn;
  }
  return undefined;
}

function buildFallback(
  gateway: WarpgateGateway,
  target: WarpgateSshTarget,
): SshFallbackRoute {
  return {
    id: `wg-fb-${gateway.id}-${target.id}`,
    kind: "plugin",
    pluginId: PLUGIN_ID_WARPGATE,
    gatewayId: gateway.id,
    targetId: target.id,
    targetName: target.name,
    label: `${gateway.name || gateway.baseUrl} · ${target.name}`,
    order: 0,
  };
}

/**
 * 拉取所有网关下的 SSH Target，拼成导入列表行。
 * `force` 为 true 时强制打 API。
 */
export async function loadWarpgateImportRows(opts?: {
  force?: boolean;
}): Promise<{ rows: WarpgateImportRow[]; gateways: WarpgateGateway[] }> {
  const gateways = await loadWarpgateGateways();
  const rows: WarpgateImportRow[] = [];
  for (const gateway of gateways) {
    try {
      const targets = await listWarpgateSshTargets(gateway, { force: opts?.force });
      for (const target of targets) {
        rows.push({
          key: warpgateImportKey(gateway.id, target.id),
          gateway,
          target,
        });
      }
    } catch {
      /* 单个网关失败不阻断其余 */
    }
  }
  return { rows, gateways };
}

/**
 * 将勾选的 Warpgate Target 导入为 SSH 连接（经堡垒主机可达）。
 * 已存在（同网关+target 或同名）则更新 host/user/port/密码与备选路由。
 */
export async function importWarpgateSshPicks(
  picks: WarpgateImportPick[],
): Promise<WarpgateImportResult> {
  const result: WarpgateImportResult = {
    added: 0,
    updated: 0,
    skipped: 0,
    failures: [],
    savedIds: [],
  };
  if (picks.length === 0) return result;

  const gateways = await loadWarpgateGateways();
  const byGw = new Map(gateways.map((g) => [g.id, g]));
  const save = useConnectionStore.getState().save;

  for (const pick of picks) {
    const gateway = byGw.get(pick.gatewayId);
    if (!gateway) {
      result.failures.push(`${pick.targetName}: 网关不存在`);
      continue;
    }
    try {
      const resolved = await resolveWarpgateSshRoute(gateway, {
        targetId: pick.targetId,
        targetName: pick.targetName,
      });
      const target: WarpgateSshTarget = {
        id: pick.targetId,
        name: pick.targetName || resolved.targetName || pick.targetId,
        kind: "ssh",
        bastionHost: resolved.host,
        bastionPort: resolved.port,
        loginUser: gateway.loginUser,
      };
      const fallback = buildFallback(gateway, target);
      const existing = findExistingByWarpgate(
        useConnectionStore.getState().connections,
        gateway.id,
        pick.targetId,
        target.name,
      );
      const password = resolved.password?.trim() ?? "";
      const draft: Connection = {
        id: existing?.id ?? "",
        kind: "ssh",
        name: target.name,
        group: existing?.group ?? "默认",
        envTag: existing?.envTag ?? "unknown",
        tags: existing?.tags ?? [],
        config: JSON.stringify({
          host: resolved.host,
          port: resolved.port || 2222,
          user: resolved.user,
          auth: {
            type: "password",
            // 留空表示保留原 Vault 密码（更新且网关无密码时）
            ...(password || !existing ? { password } : { password: "" }),
          },
          fallbacks: [fallback],
          // 导入即经堡垒，默认选用该备选路由
          preferredRoute: fallback.id,
        }),
        createdAt: existing?.createdAt,
        updatedAt: Math.floor(Date.now() / 1000),
      };
      const saved = await save(draft);
      if (!saved) {
        result.failures.push(`${target.name}: 保存失败`);
        continue;
      }
      result.savedIds.push(saved.id);
      if (existing) result.updated += 1;
      else result.added += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.failures.push(`${pick.targetName}: ${msg}`);
    }
  }

  return result;
}
