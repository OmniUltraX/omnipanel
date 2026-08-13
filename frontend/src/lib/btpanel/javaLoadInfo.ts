import type { BtJavaProjectLoadInfo } from "./types";

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 显式 `*_percent`（如 psutil cpu_percent）已是 0–100，不要把 0.95 当成 0–1 小数。
 * 仅对无 percent 语义的裸字段（如 cpu=0.12）做小数放大。
 */
function normalizePercent(
  value: number | null,
  opts?: { alreadyPercent?: boolean },
): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  let pct = value;
  if (!opts?.alreadyPercent && value > 0 && value < 1) {
    pct = value * 100;
  }
  return Math.max(0, Math.min(100, pct));
}

/** 内存字段可能是字节、KB、MB；按量级粗判。 */
function normalizeMemoryBytes(value: number | null): number | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  if (value < 10_000) return value * 1024 * 1024; // 疑似 MB
  if (value < 10_000_000) return value * 1024; // 疑似 KB
  return value;
}

function pickCpu(record: Record<string, unknown>): number | null {
  const named = asFiniteNumber(
    record.cpu_percent ?? record.cpuPercent ?? record.cpu_usage ?? record.cpuUsage,
  );
  if (named != null) return normalizePercent(named, { alreadyPercent: true });
  return normalizePercent(asFiniteNumber(record.cpu));
}

function pickMemoryPercent(record: Record<string, unknown>): number | null {
  const explicit = asFiniteNumber(
    record.memory_percent ??
      record.memoryPercent ??
      record.mem_percent ??
      record.memPercent,
  );
  if (explicit != null) return normalizePercent(explicit, { alreadyPercent: true });
  return null;
}

function pickMemoryUsed(record: Record<string, unknown>): number | null {
  const raw = asFiniteNumber(
    record.memory_used ??
      record.memoryUsed ??
      record.mem_used ??
      record.memUsed ??
      record.rss ??
      record.memory_rss,
  );
  if (raw != null) return normalizeMemoryBytes(raw);

  const memInfo = record.memory_info;
  if (memInfo && typeof memInfo === "object" && !Array.isArray(memInfo)) {
    const info = memInfo as Record<string, unknown>;
    const fromInfo = asFiniteNumber(info.uss ?? info.rss ?? info.pss ?? info.vms);
    if (fromInfo != null) return normalizeMemoryBytes(fromInfo);
  }

  const memField = asFiniteNumber(record.memory ?? record.mem);
  if (memField != null && memField > 100) return normalizeMemoryBytes(memField);
  return null;
}

function pickPid(record: Record<string, unknown>, keyHint?: string): number | null {
  const fromField = asFiniteNumber(record.pid);
  if (fromField != null) return Math.round(fromField);
  if (keyHint && /^\d+$/.test(keyHint)) return Number(keyHint);
  return null;
}

function pickThreads(record: Record<string, unknown>): number | null {
  const n = asFiniteNumber(record.threads);
  return n == null ? null : Math.max(0, Math.round(n));
}

function pickConnects(record: Record<string, unknown>): number | null {
  const n = asFiniteNumber(
    record.connects ?? record.connections_count ?? record.connection_count,
  );
  if (n != null) return Math.max(0, Math.round(n));
  if (Array.isArray(record.connections)) return record.connections.length;
  return null;
}

function pickRunningTimeSec(record: Record<string, unknown>): number | null {
  const n = asFiniteNumber(
    record.running_time ?? record.runningTime ?? record.uptime,
  );
  return n == null || n < 0 ? null : n;
}

/** 解析 -Xmx1024M / -Xms256M 等 JVM 尺寸参数。 */
export function parseJvmSizeArg(token: string): number | null {
  const m = /^-Xm[xs](\d+(?:\.\d+)?)([kKmMgGtT])?$/i.exec(token.trim());
  if (!m) return null;
  const amount = Number(m[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const unit = (m[2] ?? "b").toLowerCase();
  const mul =
    unit === "t"
      ? 1024 ** 4
      : unit === "g"
        ? 1024 ** 3
        : unit === "m"
          ? 1024 ** 2
          : unit === "k"
            ? 1024
            : 1;
  return Math.round(amount * mul);
}

function basenamePath(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const parts = norm.split("/");
  return parts[parts.length - 1] || path;
}

function collectProcessArgs(record: Record<string, unknown>): string[] {
  if (Array.isArray(record.cmdline)) {
    return record.cmdline.map((x) => String(x ?? "").trim()).filter(Boolean);
  }
  if (typeof record.exe === "string" && record.exe.trim()) {
    return record.exe.trim().split(/\s+/).filter(Boolean);
  }
  return [];
}

export type JvmRuntimeHints = {
  heapMaxBytes: number | null;
  heapMinBytes: number | null;
  serverPort: number | null;
  springProfile: string | null;
  jarName: string | null;
};

/** 从 cmdline/exe/监听端口提取 Java 关键运行参数。 */
export function parseJvmRuntimeHints(
  record: Record<string, unknown>,
): JvmRuntimeHints {
  const args = collectProcessArgs(record);
  let heapMaxBytes: number | null = null;
  let heapMinBytes: number | null = null;
  let serverPort: number | null = null;
  let springProfile: string | null = null;
  let jarName: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (/^-Xmx/i.test(arg)) {
      heapMaxBytes = parseJvmSizeArg(arg) ?? heapMaxBytes;
      continue;
    }
    if (/^-Xms/i.test(arg)) {
      heapMinBytes = parseJvmSizeArg(arg) ?? heapMinBytes;
      continue;
    }
    if (arg === "-jar") {
      for (let j = i + 1; j < args.length; j++) {
        const next = args[j]!;
        if (next.startsWith("-")) continue;
        jarName = basenamePath(next);
        break;
      }
      continue;
    }
    if (arg.startsWith("--server.port=")) {
      serverPort = asFiniteNumber(arg.slice("--server.port=".length)) ?? serverPort;
      continue;
    }
    if (arg === "--server.port" && args[i + 1]) {
      serverPort = asFiniteNumber(args[i + 1]) ?? serverPort;
      continue;
    }
    if (arg.startsWith("--spring.profiles.active=")) {
      springProfile = arg.slice("--spring.profiles.active=".length).trim() || null;
      continue;
    }
    if (arg === "--spring.profiles.active" && args[i + 1]) {
      springProfile = args[i + 1]!.trim() || null;
      continue;
    }
    // Spring 也常见 server.port=48080（无 --）
    if (/^server\.port=/i.test(arg)) {
      serverPort = asFiniteNumber(arg.split("=")[1]) ?? serverPort;
    }
    if (/^spring\.profiles\.active=/i.test(arg)) {
      springProfile = arg.split("=").slice(1).join("=").trim() || springProfile;
    }
  }

  if (serverPort == null && Array.isArray(record.connections)) {
    for (const item of record.connections) {
      if (!item || typeof item !== "object") continue;
      const conn = item as Record<string, unknown>;
      if (String(conn.status ?? "").toUpperCase() !== "LISTEN") continue;
      const port = asFiniteNumber(conn.local_port ?? conn.localPort);
      if (port != null && port > 0) {
        serverPort = Math.round(port);
        break;
      }
    }
  }

  return { heapMaxBytes, heapMinBytes, serverPort, springProfile, jarName };
}

function isProcessLoadNode(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    pickCpu(r) != null ||
    pickMemoryPercent(r) != null ||
    pickMemoryUsed(r) != null ||
    "cpu_percent" in r ||
    "memory_percent" in r ||
    "memory_used" in r ||
    "memory_info" in r ||
    "pid" in r ||
    "cmdline" in r ||
    "exe" in r
  );
}

type LoadAcc = {
  cpu: number;
  memPctSum: number;
  memPctN: number;
  memBytes: number;
  threads: number;
  connects: number;
  runningTimeSec: number | null;
  pid: number | null;
  jvm: JvmRuntimeHints | null;
  any: boolean;
};

function emptyInfo(raw: unknown): BtJavaProjectLoadInfo {
  return {
    cpuPercent: null,
    memoryPercent: null,
    memoryUsedBytes: null,
    threads: null,
    connects: null,
    runningTimeSec: null,
    pid: null,
    heapMaxBytes: null,
    heapMinBytes: null,
    serverPort: null,
    springProfile: null,
    jarName: null,
    raw,
  };
}

function mergeProcess(
  acc: LoadAcc,
  process: Record<string, unknown>,
  keyHint?: string,
): void {
  acc.any = true;
  const c = pickCpu(process);
  const mp = pickMemoryPercent(process);
  const mb = pickMemoryUsed(process);
  const th = pickThreads(process);
  const conn = pickConnects(process);
  const rt = pickRunningTimeSec(process);
  const pid = pickPid(process, keyHint);
  if (c != null) acc.cpu += c;
  if (mp != null) {
    acc.memPctSum += mp;
    acc.memPctN += 1;
  }
  if (mb != null) acc.memBytes += mb;
  if (th != null) acc.threads += th;
  if (conn != null) acc.connects += conn;
  if (rt != null) {
    acc.runningTimeSec =
      acc.runningTimeSec == null ? rt : Math.max(acc.runningTimeSec, rt);
  }
  if (pid != null && acc.pid == null) acc.pid = pid;
  // JVM 参数取主进程（首次）
  if (acc.jvm == null) {
    const hints = parseJvmRuntimeHints(process);
    if (
      hints.heapMaxBytes != null ||
      hints.heapMinBytes != null ||
      hints.serverPort != null ||
      hints.springProfile ||
      hints.jarName
    ) {
      acc.jvm = hints;
    }
  }
}

function finalize(acc: LoadAcc, raw: unknown): BtJavaProjectLoadInfo {
  if (!acc.any) return emptyInfo(raw);
  const heapMax = acc.jvm?.heapMaxBytes ?? null;
  const used = acc.memBytes > 0 ? acc.memBytes : null;
  let memoryPercent =
    acc.memPctN > 0
      ? normalizePercent(acc.memPctSum, { alreadyPercent: true })
      : null;
  // 无显式百分比时：进程内存 / -Xmx（可 >100%，条上 clamp）
  if (memoryPercent == null && used != null && heapMax != null && heapMax > 0) {
    memoryPercent = normalizePercent((used / heapMax) * 100, {
      alreadyPercent: true,
    });
  }
  return {
    cpuPercent: normalizePercent(acc.cpu, { alreadyPercent: true }),
    memoryPercent,
    memoryUsedBytes: used,
    threads: acc.threads > 0 ? acc.threads : null,
    connects: acc.connects > 0 ? acc.connects : null,
    runningTimeSec: acc.runningTimeSec,
    pid: acc.pid,
    heapMaxBytes: heapMax,
    heapMinBytes: acc.jvm?.heapMinBytes ?? null,
    serverPort: acc.jvm?.serverPort ?? null,
    springProfile: acc.jvm?.springProfile ?? null,
    jarName: acc.jvm?.jarName ?? null,
    raw,
  };
}

/**
 * 宽松解析 get_load_info 响应。
 * 实测形态：`{ code:1, status:true, msg:"success", data: { "<pid>": { cpu_percent, memory_used, ... } } }`
 */
export function parseBtJavaProjectLoadInfo(payload: unknown): BtJavaProjectLoadInfo {
  if (payload == null) {
    console.debug("[bt-java-load] parse: null payload");
    return emptyInfo(payload);
  }

  // 偶发双重 JSON 字符串
  let normalized: unknown = payload;
  if (typeof payload === "string") {
    try {
      normalized = JSON.parse(payload) as unknown;
    } catch {
      return emptyInfo(payload);
    }
  }

  let root: unknown = normalized;
  if (typeof normalized === "object" && !Array.isArray(normalized) && normalized) {
    const obj = normalized as Record<string, unknown>;
    let data = obj.data;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data) as unknown;
      } catch {
        // keep string
      }
    }
    if (data != null && typeof data === "object") {
      root = data;
      console.debug("[bt-java-load] parse: use payload.data", {
        keys: Object.keys(data as object),
      });
    } else if (obj.msg != null && typeof obj.msg === "object") {
      root = obj.msg;
      console.debug("[bt-java-load] parse: use payload.msg object");
    } else {
      console.debug("[bt-java-load] parse: use payload root", {
        keys: Object.keys(obj),
        status: obj.status,
        msg: obj.msg,
        code: obj.code,
      });
    }
  }

  const acc: LoadAcc = {
    cpu: 0,
    memPctSum: 0,
    memPctN: 0,
    memBytes: 0,
    threads: 0,
    connects: 0,
    runningTimeSec: null,
    pid: null,
    jvm: null,
    any: false,
  };

  if (Array.isArray(root)) {
    for (const item of root) {
      if (!isProcessLoadNode(item)) continue;
      mergeProcess(acc, item);
    }
    return finalize(acc, payload);
  }

  if (!root || typeof root !== "object") return emptyInfo(payload);
  const record = root as Record<string, unknown>;

  // 扁平单进程
  if (
    isProcessLoadNode(record) &&
    (pickCpu(record) != null ||
      pickMemoryPercent(record) != null ||
      pickMemoryUsed(record) != null) &&
    !Object.keys(record).some((k) => /^\d+$/.test(k) && isProcessLoadNode(record[k]))
  ) {
    mergeProcess(acc, record);
    return finalize(acc, payload);
  }

  // pid → process info 字典（宝塔 get_load_info 主形态）
  for (const [key, value] of Object.entries(record)) {
    if (key === "status" || key === "msg" || key === "page" || key === "code") {
      continue;
    }
    if (!isProcessLoadNode(value)) continue;
    mergeProcess(acc, value, key);
  }
  if (!acc.any) {
    mergeProcess(acc, record);
  }
  const result = finalize(acc, payload);
  console.debug("[bt-java-load] parse result", {
    cpuPercent: result.cpuPercent,
    memoryPercent: result.memoryPercent,
    memoryUsedBytes: result.memoryUsedBytes,
    threads: result.threads,
    connects: result.connects,
    runningTimeSec: result.runningTimeSec,
    pid: result.pid,
    heapMaxBytes: result.heapMaxBytes,
    heapMinBytes: result.heapMinBytes,
    serverPort: result.serverPort,
    springProfile: result.springProfile,
    jarName: result.jarName,
  });
  return result;
}
