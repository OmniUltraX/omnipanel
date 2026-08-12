import {
  commands,
  type DbConnectionConfig as IpcDbConnectionConfig,
} from "../../../../ipc/bindings";
import { unwrapCommand } from "../../../../ipc/result";
import {
  formatBytesLabel,
  infoValue,
} from "../../../database/redis/redisInfoHelpers";
import type { RedisInfoResult } from "../../../database/api";
import { fetchHostMemoryTotalBytes } from "../hostDiskTotal";

export type RedisMemoryCeilingSource = "maxmemory" | "host-ram";

export type RedisOverviewSnapshot = {
  usedMemoryBytes: number | null;
  /** 有效上限：maxmemory，或未设置时回退主机物理内存 */
  maxMemoryBytes: number | null;
  /** 上限来源；两者皆无则为 null */
  maxMemorySource: RedisMemoryCeilingSource | null;
  connectedClients: number | null;
  maxClients: number | null;
  keyspaceHits: number | null;
  keyspaceMisses: number | null;
  memFragmentationRatio: number | null;
  usedMemoryHuman: string;
  fetchedAt: number;
};

/** 碎片率进度条：2.0 视为满格（常见告警阈值附近） */
export const REDIS_FRAG_RATIO_BAR_FULL = 2;

function parseIntOrNull(raw: string | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function parseFloatOrNull(raw: string | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

async function fetchConfigMap(
  connection: IpcDbConnectionConfig,
  pattern: string,
): Promise<Map<string, string>> {
  const entries = await unwrapCommand(
    commands.dbRedisConfigGetEntries(connection, pattern),
    { quiet: true },
  ).catch(() => [] as [string, string][]);
  const map = new Map<string, string>();
  for (const pair of entries ?? []) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const key = String(pair[0] ?? "")
      .trim()
      .toLowerCase();
    if (!key) continue;
    map.set(key, String(pair[1] ?? "").trim());
  }
  return map;
}

/** 拉取 Redis INFO + CONFIG（maxmemory / maxclients / dir）。 */
export async function fetchRedisOverviewSnapshot(
  connection: IpcDbConnectionConfig,
): Promise<RedisOverviewSnapshot> {
  const [infoRaw, maxmemoryCfg, maxclientsCfg] = await Promise.all([
    unwrapCommand(commands.dbRedisInfo(connection, null), { quiet: true }),
    fetchConfigMap(connection, "maxmemory"),
    fetchConfigMap(connection, "maxclients"),
  ]);

  const info: RedisInfoResult = { sections: infoRaw.sections ?? {} };

  const usedMemoryBytes = parseIntOrNull(
    infoValue(info, "Memory", "used_memory"),
  );
  const maxFromInfo = parseIntOrNull(infoValue(info, "Memory", "maxmemory"));
  const maxFromConfig = parseIntOrNull(maxmemoryCfg.get("maxmemory"));
  const configuredMax = maxFromConfig ?? maxFromInfo;
  const maxmemoryUnset = configuredMax == null || configuredMax <= 0;

  let maxMemoryBytes: number | null = null;
  let maxMemorySource: RedisMemoryCeilingSource | null = null;
  if (!maxmemoryUnset && configuredMax != null) {
    maxMemoryBytes = configuredMax;
    maxMemorySource = "maxmemory";
  } else {
    const hostRam = await fetchHostMemoryTotalBytes(connection.host);
    if (hostRam != null && hostRam > 0) {
      maxMemoryBytes = hostRam;
      maxMemorySource = "host-ram";
    }
  }

  const connectedClients = parseIntOrNull(
    infoValue(info, "Clients", "connected_clients"),
  );
  const maxClients =
    parseIntOrNull(maxclientsCfg.get("maxclients")) ??
    parseIntOrNull(infoValue(info, "Clients", "maxclients"));

  const keyspaceHits = parseIntOrNull(
    infoValue(info, "Stats", "keyspace_hits"),
  );
  const keyspaceMisses = parseIntOrNull(
    infoValue(info, "Stats", "keyspace_misses"),
  );

  const memFragmentationRatio = parseFloatOrNull(
    infoValue(info, "Memory", "mem_fragmentation_ratio"),
  );

  return {
    usedMemoryBytes,
    maxMemoryBytes,
    maxMemorySource,
    connectedClients,
    maxClients,
    keyspaceHits,
    keyspaceMisses,
    memFragmentationRatio,
    usedMemoryHuman: formatBytesLabel(
      infoValue(info, "Memory", "used_memory"),
    ),
    fetchedAt: Date.now(),
  };
}

