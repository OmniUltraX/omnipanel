/** 宝塔 GetDiskInfo 单盘用量（字节），供监控面板换算。 */
export type BtDiskUsageBytes = {
  path: string;
  total: number;
  used: number;
  free: number;
  usedPercent: number;
  fileSystem?: string;
};

/** 解析宝塔人类可读容量（如 `19.5 GB` / `4.8G` / `859.4 MB`）为字节。 */
export function parseBtHumanSizeToBytes(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(0, raw);
  }
  const text = String(raw ?? "").trim();
  if (!text) return 0;
  const match = text.match(/^([\d.]+)\s*([KMGTPE]?)(I?B)?$/i);
  if (!match) {
    const asNum = Number.parseFloat(text);
    return Number.isFinite(asNum) ? Math.max(0, asNum) : 0;
  }
  const value = Number.parseFloat(match[1] ?? "");
  if (!Number.isFinite(value)) return 0;
  const unit = (match[2] ?? "").toUpperCase();
  const exp =
    unit === "K" ? 1 : unit === "M" ? 2 : unit === "G" ? 3 : unit === "T" ? 4 : unit === "P" ? 5 : unit === "E" ? 6 : 0;
  // 面板展示习惯接近 1024 进制，与 byte_size 对齐
  const factor = unit ? 1024 ** exp : 1;
  return Math.max(0, Math.round(value * factor));
}

type BtDiskInfoLike = {
  path?: string;
  size?: Array<string | number>;
  /** 官方：[总字节, 已用字节, 剩余字节] */
  byte_size?: Array<number | string>;
  filesystem?: string;
  type?: string;
};

/**
 * 将宝塔 GetDiskInfo 单项转为字节用量。
 * 官方 `size` 顺序为 `[总大小, 已用, 可用, 使用率%, …]`，勿与旧代码「已用/总」颠倒。
 * 优先 `byte_size`。
 */
export function parseBtDiskUsage(disk: BtDiskInfoLike): BtDiskUsageBytes | null {
  const path = String(disk.path ?? "").trim() || "/";
  const fileSystem = disk.filesystem ?? disk.type;

  const byteSize = Array.isArray(disk.byte_size) ? disk.byte_size : null;
  if (byteSize && byteSize.length >= 2) {
    const total = Math.max(0, Number(byteSize[0]) || 0);
    const used = Math.max(0, Number(byteSize[1]) || 0);
    const free =
      byteSize.length >= 3
        ? Math.max(0, Number(byteSize[2]) || 0)
        : Math.max(0, total - used);
    if (total <= 0 && used <= 0) return null;
    return {
      path,
      total,
      used,
      free,
      usedPercent: total > 0 ? (used / total) * 100 : 0,
      fileSystem,
    };
  }

  const size = Array.isArray(disk.size) ? disk.size : [];
  if (size.length < 2) return null;
  // size: [总, 已用, 可用, 使用率%]
  const total = parseBtHumanSizeToBytes(size[0]);
  const used = parseBtHumanSizeToBytes(size[1]);
  const free =
    size.length >= 3 ? parseBtHumanSizeToBytes(size[2]) : Math.max(0, total - used);
  if (total <= 0 && used <= 0) return null;
  const pctRaw = size[3];
  const pctFromApi =
    typeof pctRaw === "string"
      ? Number.parseFloat(pctRaw)
      : typeof pctRaw === "number"
        ? pctRaw
        : NaN;
  return {
    path,
    total,
    used,
    free,
    usedPercent:
      Number.isFinite(pctFromApi) && pctFromApi >= 0
        ? pctFromApi
        : total > 0
          ? (used / total) * 100
          : 0,
    fileSystem,
  };
}

/** 批量解析，过滤无效项。 */
export function parseBtDiskUsageList(disks: readonly BtDiskInfoLike[]): BtDiskUsageBytes[] {
  const out: BtDiskUsageBytes[] = [];
  for (const disk of disks) {
    const parsed = parseBtDiskUsage(disk);
    if (parsed) out.push(parsed);
  }
  return out;
}
