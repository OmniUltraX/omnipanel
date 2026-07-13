import type { DockerContainerStats, DockerContainerSummary } from "../../ipc/bindings";
import { normalizeStatsId } from "./dockerStatsDebug";

export function statsKey(containerId: string): string {
  return normalizeStatsId(containerId);
}

/** Docker 短 ID 为完整 ID 前缀，双向前缀匹配。 */
export function statsIdsMatch(left: string, right: string): boolean {
  if (!left || !right) return false;
  return left === right || left.startsWith(right) || right.startsWith(left);
}

export function pickStats(
  container: DockerContainerSummary,
  statsById: Map<string, DockerContainerStats>,
): DockerContainerStats | null {
  const fullId = statsKey(container.id);
  const direct = statsById.get(fullId);
  if (direct) return direct;

  const containerName = container.name.trim();
  if (containerName) {
    const byName = statsById.get(`name:${containerName.toLowerCase()}`);
    if (byName) return byName;
  }

  const short = statsKey(container.shortId);
  const byShort = statsById.get(short);
  if (byShort) return byShort;

  if (fullId.length >= 12) {
    const byFullPrefix = statsById.get(fullId.slice(0, 12));
    if (byFullPrefix) return byFullPrefix;
  }

  for (const [key, stats] of statsById) {
    if (key.startsWith("name:")) continue;
    if (statsIdsMatch(key, short) || statsIdsMatch(key, fullId)) {
      return stats;
    }
    const statsId = statsKey(stats.containerId);
    if (statsIdsMatch(statsId, fullId) || statsIdsMatch(statsId, short)) {
      return stats;
    }
  }
  return null;
}

export function statsMapFromList(statsList: DockerContainerStats[]): Map<string, DockerContainerStats> {
  const nextStats = new Map<string, DockerContainerStats>();
  for (const item of statsList) {
    const normalized = statsKey(item.containerId);
    if (normalized) {
      nextStats.set(normalized, item);
      if (normalized.length >= 12) {
        nextStats.set(normalized.slice(0, 12), item);
      }
    }
    if (item.name.trim()) {
      nextStats.set(`name:${item.name.trim().toLowerCase()}`, item);
    }
  }
  return nextStats;
}
