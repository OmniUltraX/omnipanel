import { commands, type DiskStats } from "../../../ipc/bindings";
import { useConnectionStore } from "../../../stores/connectionStore";
import {
  findSshConnectionForDbHost,
  isSshConnectionEstablished,
} from "../../database/mysqlSlowQueryLog";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeFsPath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/");
  if (!trimmed) return "";
  if (trimmed === "/") return "/";
  return trimmed.replace(/\/+$/, "");
}

function parsePositiveNumber(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 按路径匹配最长挂载点；否则回退磁盘汇总 total */
export function resolveDiskTotalForPath(
  disk: DiskStats | null | undefined,
  pathHint: string,
): number | null {
  if (!disk) return null;
  const path = normalizeFsPath(pathHint);
  const devices = disk.disks ?? [];
  let bestTotal: number | null = null;
  let bestLen = -1;
  for (const d of devices) {
    const mount = normalizeFsPath(d.mountPoint || "");
    if (!mount) continue;
    const matches =
      !path ||
      path === mount ||
      path.startsWith(`${mount}/`) ||
      mount === "/";
    if (!matches) continue;
    if (d.total == null || d.total <= 0) continue;
    if (mount.length >= bestLen) {
      bestLen = mount.length;
      bestTotal = d.total;
    }
  }
  if (bestTotal != null) return bestTotal;
  if (disk.total != null && disk.total > 0) return disk.total;
  return null;
}

/**
 * 磁盘总量：匹配 DB/服务 host 对应 SSH，读取主机磁盘统计（优先 pathHint 所在挂载点）。
 * 不弹窗强制建连；池会话可用时再取数。
 */
export async function fetchHostDiskTotalBytes(
  dbHost: string,
  pathHint: string,
): Promise<number | null> {
  try {
    const store = useConnectionStore.getState();
    if (!store.loaded) {
      await store.refresh();
    }
    const sshConnections = useConnectionStore
      .getState()
      .connections.filter((c) => c.kind === "ssh");
    const ssh = await findSshConnectionForDbHost(sshConnections, dbHost);
    if (!ssh) return null;

    const statsRes = await commands.sshPoolFetchStats(ssh.id);
    if (statsRes.status === "ok") {
      const fromStats = resolveDiskTotalForPath(statsRes.data.disk, pathHint);
      if (fromStats != null) return fromStats;
    }

    if (!isSshConnectionEstablished(ssh.id)) return null;

    const dir = pathHint.trim();
    if (!dir) return null;
    const exec = await commands.sshPoolExecCommand(
      ssh.id,
      `df -kP ${shellQuote(dir)} 2>/dev/null | awk 'NR==2 {print $2}'`,
    );
    if (exec.status !== "ok") return null;
    const kib = parsePositiveNumber(exec.data.stdout.trim().split(/\s+/)[0]);
    if (kib == null) return null;
    return kib * 1024;
  } catch {
    return null;
  }
}

/**
 * 主机物理内存总量：匹配 host 对应 SSH，读取 sshPoolFetchStats.memory.total。
 * 不弹窗强制建连。
 */
export async function fetchHostMemoryTotalBytes(
  dbHost: string,
): Promise<number | null> {
  try {
    const store = useConnectionStore.getState();
    if (!store.loaded) {
      await store.refresh();
    }
    const sshConnections = useConnectionStore
      .getState()
      .connections.filter((c) => c.kind === "ssh");
    const ssh = await findSshConnectionForDbHost(sshConnections, dbHost);
    if (!ssh) return null;

    const statsRes = await commands.sshPoolFetchStats(ssh.id);
    if (statsRes.status !== "ok") return null;
    const total = statsRes.data.memory?.total;
    if (total == null || !Number.isFinite(total) || total <= 0) return null;
    return total;
  } catch {
    return null;
  }
}

