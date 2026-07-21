/**
 * 从 `docker run …` 命令中解析镜像名（启发式，覆盖常见 OPTIONS）。
 */
const DOCKER_RUN_VALUE_OPTS = new Set([
  "-a",
  "--attach",
  "--annotation",
  "--blkio-weight",
  "--blkio-weight-device",
  "--cap-add",
  "--cap-drop",
  "--cgroup-parent",
  "--cgroupns",
  "--cidfile",
  "--cpu-period",
  "--cpu-quota",
  "--cpu-rt-period",
  "--cpu-rt-runtime",
  "--cpu-shares",
  "-c",
  "--cpus",
  "--cpuset-cpus",
  "--cpuset-mems",
  "--device",
  "--device-cgroup-rule",
  "--device-read-bps",
  "--device-read-iops",
  "--device-write-bps",
  "--device-write-iops",
  "--dns",
  "--dns-option",
  "--dns-search",
  "--domainname",
  "--entrypoint",
  "-e",
  "--env",
  "--env-file",
  "--expose",
  "--gpus",
  "--group-add",
  "--health-cmd",
  "--health-interval",
  "--health-retries",
  "--health-start-period",
  "--health-timeout",
  "-h",
  "--hostname",
  "--ip",
  "--ip6",
  "--ipc",
  "--isolation",
  "--kernel-memory",
  "-l",
  "--label",
  "--label-file",
  "--link",
  "--link-local-ip",
  "--log-driver",
  "--log-opt",
  "--mac-address",
  "-m",
  "--memory",
  "--memory-reservation",
  "--memory-swap",
  "--memory-swappiness",
  "--mount",
  "--name",
  "--network",
  "--net",
  "--network-alias",
  "--oom-score-adj",
  "--pid",
  "--pids-limit",
  "--platform",
  "-p",
  "--publish",
  "--pull",
  "--restart",
  "--runtime",
  "--security-opt",
  "--shm-size",
  "--stop-signal",
  "--stop-timeout",
  "--storage-opt",
  "--sysctl",
  "--tmpfs",
  "-u",
  "--user",
  "--userns",
  "--ulimit",
  "--uts",
  "-v",
  "--volume",
  "--volume-driver",
  "--volumes-from",
  "-w",
  "--workdir",
  "--add-host",
]);

/** 简易 shell 分词（支持双引号 / 单引号）。 */
export function tokenizeDockerCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function optionTakesValue(token: string): boolean {
  if (token.includes("=")) return false;
  if (DOCKER_RUN_VALUE_OPTS.has(token)) return true;
  // 短选项连写如 -it 不取值；-eVAR 少见，忽略
  return false;
}

export function extractDockerRunImage(command: string): string | null {
  const tokens = tokenizeDockerCommand(command.trim());
  if (tokens.length === 0) return null;
  let i = 0;
  if (tokens[i]!.toLowerCase() !== "docker") return null;
  i += 1;

  // docker 全局选项（少见）：跳过
  while (i < tokens.length && tokens[i]!.startsWith("-")) {
    const t = tokens[i]!;
    if (optionTakesValue(t)) i += 2;
    else i += 1;
  }

  if (tokens[i]?.toLowerCase() !== "run") return null;
  i += 1;

  while (i < tokens.length) {
    const t = tokens[i]!;
    if (!t.startsWith("-")) {
      return t;
    }
    if (t.includes("=")) {
      i += 1;
      continue;
    }
    if (optionTakesValue(t)) {
      i += 2;
      continue;
    }
    i += 1;
  }
  return null;
}

/** 为 docker run 注入 / 覆盖为 --pull=never，避免再次直连 Hub 拉镜像。 */
export function ensureDockerRunPullNever(command: string): string {
  const trimmed = command.trim();
  if (!/\brun\b/i.test(trimmed)) return trimmed;
  // 去掉已有 --pull=… / --pull …
  const withoutPull = trimmed
    .replace(/--pull=\S+/gi, "")
    .replace(/--pull\s+\S+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return withoutPull.replace(/\brun\b/i, "run --pull=never");
}
