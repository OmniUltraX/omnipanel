import { commands } from "../../../ipc/bindings";

import { LOCAL_CONNECTION_ID } from "../../../modules/files/utils";

import type { DbConnectionConfig } from "../../../modules/database/api";

import { redisConfigGet } from "../../../modules/database/api";

import type { RedisDeploymentInfo } from "../../../modules/database/redisDeploymentDetect";

import { ensureSshReady } from "../../../modules/database/mysqlSlowQueryLog";

import {

  redisConfigLog,

  redisConfigWarn,

  summarizeDeployment,

} from "../../../modules/database/redisConfigDebug";

import {

  createRemoteConfigTextIO,

  type RemoteConfigDeployment,

} from "./remoteConfigTextIO";

import type { TextEditorIO } from "../types";



/** 常见 Redis 配置路径（Linux / macOS / 官方 Docker 镜像）。 */

export const REDIS_CONFIG_CANDIDATES = [

  "/usr/local/etc/redis/redis.conf",

  "/etc/redis/redis.conf",

  "/etc/redis.conf",

  "/usr/local/etc/redis.conf",

  "/opt/homebrew/etc/redis.conf",

  "/data/redis.conf",

  "/conf/redis.conf",

];



function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 从 pid 文件路径解析所在目录。 */
function resolveDirectoryFromPath(filePath: string): string | null {
  const normalized = filePath.trim().replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  if (slash <= 0) {
    return null;
  }
  return normalized.slice(0, slash);
}

/** 主机部署：pid 与 redis.conf 通常在同一目录。 */
function buildConfigPathsBesidePid(pidFile: string): string[] {
  const dir = resolveDirectoryFromPath(pidFile);
  if (!dir) {
    return [];
  }
  return [`${dir}/redis.conf`];
}

function normalizeDirPath(dir: string): string {
  return dir.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

/** 通过 CONFIG GET dir 得到的安装目录查找 redis.conf。 */
function buildConfigPathsInInstallDir(dir: string): string[] {
  const normalized = normalizeDirPath(dir);
  if (!normalized) {
    return [];
  }
  return [`${normalized}/redis.conf`];
}

async function findConfigInInstallDir(
  sshId: string | undefined,
  containerId: string | undefined,
  dir: string | undefined,
): Promise<string | null> {
  if (!dir?.trim()) {
    return null;
  }
  const candidates = buildConfigPathsInInstallDir(dir);
  redisConfigLog("probe.install-dir.start", { dir: dir.trim(), candidates });
  for (const path of candidates) {
    if (await remotePathExists(sshId, path, containerId, "install-dir")) {
      redisConfigLog("probe.install-dir.hit", { path, dir: dir.trim() });
      return path;
    }
  }
  redisConfigLog("probe.install-dir.miss", { dir: dir.trim(), candidates });
  return null;
}

async function findConfigBesidePidFile(
  sshId: string | undefined,
  containerId: string | undefined,
  pidFile: string | undefined,
): Promise<string | null> {
  if (!pidFile?.trim()) {
    return null;
  }
  const candidates = buildConfigPathsBesidePid(pidFile.trim());
  redisConfigLog("probe.pid-dir.start", { pidFile: pidFile.trim(), candidates });
  for (const path of candidates) {
    if (await remotePathExists(sshId, path, containerId, "pid-dir")) {
      redisConfigLog("probe.pid-dir.hit", { path, pidFile: pidFile.trim() });
      return path;
    }
  }
  redisConfigLog("probe.pid-dir.miss", { pidFile: pidFile.trim(), candidates });
  return null;
}

async function sshExec(sshId: string, command: string, label?: string): Promise<string> {

  redisConfigLog("ssh.exec", { label: label ?? "unnamed", sshId, command });

  const res = await commands.sshPoolExecCommand(sshId, command);

  if (res.status !== "ok") {

    const message =

      typeof res.error === "string" ? res.error : res.error?.message ?? "SSH 执行失败";

    redisConfigWarn("ssh.exec.failed", { label: label ?? "unnamed", sshId, message, command });

    throw new Error(message);

  }

  redisConfigLog("ssh.exec.ok", {

    label: label ?? "unnamed",

    stdout: res.data.stdout.trim(),

    stderr: res.data.stderr.trim() || undefined,

  });

  return res.data.stdout;

}



function buildDiscoverConfigCommand(): string {

  const paths = REDIS_CONFIG_CANDIDATES.join(" ");

  return [

    `for p in ${paths}; do if [ -f "$p" ]; then printf '%s' "$p"; exit 0; fi; done`,

    `found=$(find /etc /usr/local/etc /opt/homebrew/etc /data /conf -maxdepth 8 -name redis.conf 2>/dev/null | head -1)`,

    `if [ -n "$found" ] && [ -f "$found" ]; then printf '%s' "$found"; exit 0; fi`,

    `printf ''`,

  ].join("; ");

}



async function readConfigFromProcessCmdline(

  runShell: (script: string) => Promise<string>,

  pidFile?: string,

  label = "process-cmdline",

): Promise<string | null> {

  const pidFromFile = pidFile?.trim()

    ? `pid=$(cat ${shellQuote(pidFile.trim())} 2>/dev/null);`

    : "pid=";

  const script = [

    pidFromFile,

    'if [ -z "$pid" ] || [ ! -r "/proc/$pid/cmdline" ]; then pid=1; fi',

    'cmd=$(tr "\\0" " " < "/proc/$pid/cmdline" 2>/dev/null)',

    'for token in $cmd; do',

    '  case "$token" in',

    '    *.conf) printf "%s" "$token"; exit 0 ;;',

    '  esac',

    'done',

    "printf ''",

  ].join(" ");

  redisConfigLog("probe.cmdline.start", { label, pidFile: pidFile ?? "" });

  try {

    const out = (await runShell(script)).trim();

    redisConfigLog("probe.cmdline.result", { label, raw: out || "(empty)" });

    if (!out || !out.includes(".conf")) {

      return null;

    }

    const path = out.split("\n").map((line) => line.trim()).find(Boolean) ?? null;

    redisConfigLog("probe.cmdline.parsed", { label, path: path ?? "(none)" });

    return path;

  } catch (error) {

    redisConfigWarn("probe.cmdline.failed", {

      label,

      error: error instanceof Error ? error.message : String(error),

    });

    return null;

  }

}



async function readConfigFromDockerMounts(

  sshId: string,

  containerId: string,

): Promise<string | null> {

  redisConfigLog("probe.docker-mounts.start", { sshId, containerId });

  try {

    const inspectCmd = `docker inspect -f '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\\n"}}{{end}}' ${shellQuote(containerId)} 2>/dev/null`;

    const mountsRaw = await sshExec(sshId, inspectCmd, "docker-inspect-mounts");

    redisConfigLog("probe.docker-mounts.raw", { mounts: mountsRaw.trim() || "(empty)" });



    const out = await sshExec(

      sshId,

      `docker inspect -f '{{range .Mounts}}{{if eq .Destination "/usr/local/etc/redis/redis.conf"}}{{.Source}}{{end}}{{if eq .Destination "/etc/redis/redis.conf"}}{{.Source}}{{end}}{{if eq .Destination "/etc/redis.conf"}}{{.Source}}{{end}}{{end}}' ${shellQuote(containerId)} 2>/dev/null`,

      "docker-inspect-config-mount",

    );

    const path = out.trim();

    redisConfigLog("probe.docker-mounts.candidate", { path: path || "(empty)" });

    if (!path) {

      return null;

    }

    const exists = await remotePathExists(sshId, path, undefined, "docker-mount-host");

    redisConfigLog("probe.docker-mounts.exists", { path, exists });

    if (exists) {

      return path;

    }

  } catch (error) {

    redisConfigWarn("probe.docker-mounts.failed", {

      error: error instanceof Error ? error.message : String(error),

    });

  }

  return null;

}



async function remotePathExists(

  sshId: string | undefined,

  path: string,

  containerId: string | undefined,

  label = "path-exists",

): Promise<boolean> {

  redisConfigLog("probe.exists.start", { label, path, sshId: sshId ?? "", containerId: containerId ?? "" });

  try {

    if (sshId && containerId) {

      const out = await sshExec(

        sshId,

        `docker exec ${shellQuote(containerId)} sh -c "test -f ${shellQuote(path)} && echo 1 || echo 0" 2>/dev/null`,

        `${label}:docker`,

      );

      const exists = out.trim() === "1";

      redisConfigLog("probe.exists.result", { label, path, scope: "docker", exists });

      return exists;

    }

    if (sshId) {

      const out = await sshExec(

        sshId,

        `test -f ${shellQuote(path)} && echo 1 || echo 0`,

        `${label}:host`,

      );

      const exists = out.trim() === "1";

      redisConfigLog("probe.exists.result", { label, path, scope: "host", exists });

      return exists;

    }

    const res = await commands.fileReadFile(LOCAL_CONNECTION_ID, path, 1);

    const exists = res.status === "ok";

    redisConfigLog("probe.exists.result", {

      label,

      path,

      scope: "local",

      exists,

      error: exists ? undefined : res.error,

    });

    return exists;

  } catch (error) {

    redisConfigWarn("probe.exists.failed", {

      label,

      path,

      error: error instanceof Error ? error.message : String(error),

    });

    return false;

  }

}



async function resolveLiveDir(
  connection: DbConnectionConfig,
  deployment: RedisDeploymentInfo,
): Promise<string> {
  const cached = deployment.dir?.trim();
  if (cached) {
    redisConfigLog("install-dir.cached", { dir: cached });
    return cached;
  }
  if (deployment.kind === "host" && deployment.locationTag?.trim()) {
    const fromTag = deployment.locationTag.trim();
    redisConfigLog("install-dir.location-tag", { dir: fromTag });
    return fromTag;
  }
  try {
    redisConfigLog("install-dir.query", {
      connection: `${connection.host}:${connection.port}`,
    });
    const pairs = await redisConfigGet(connection, "dir");
    redisConfigLog("install-dir.query.result", { pairs });
    const hit = pairs.find(([key]) => key.toLowerCase() === "dir");
    const live = String(hit?.[1] ?? "").trim();
    redisConfigLog("install-dir.live", { dir: live || "(empty)" });
    return live;
  } catch (error) {
    redisConfigWarn("install-dir.query.failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "";
  }
}



async function discoverConfigPath(

  runShell: (script: string) => Promise<string>,

  label: string,

): Promise<string | null> {

  redisConfigLog("probe.discover.start", { label });

  try {

    const out = (await runShell(buildDiscoverConfigCommand())).trim();

    redisConfigLog("probe.discover.raw", { label, raw: out || "(empty)" });

    if (!out) return null;

    const line = out.split("\n").map((s) => s.trim()).find(Boolean);

    redisConfigLog("probe.discover.parsed", { label, path: line ?? "(none)" });

    return line ?? null;

  } catch (error) {

    redisConfigWarn("probe.discover.failed", {

      label,

      error: error instanceof Error ? error.message : String(error),

    });

    return null;

  }

}



async function probeStaticCandidatePaths(

  sshId: string | undefined,

  containerId: string | undefined,

): Promise<string | null> {

  redisConfigLog("probe.static.start", {

    sshId: sshId ?? "",

    containerId: containerId ?? "",

    candidates: REDIS_CONFIG_CANDIDATES,

  });

  for (const path of REDIS_CONFIG_CANDIDATES) {

    try {

      let hit = false;

      if (sshId && containerId) {

        const out = await sshExec(

          sshId,

          `docker exec ${shellQuote(containerId)} sh -c "test -f '${path.replace(/'/g, `'\\''`)}' && echo 1 || echo 0" 2>/dev/null`,

          `static-candidate:docker:${path}`,

        );

        hit = out.trim() === "1";

      } else if (sshId) {

        const out = await sshExec(

          sshId,

          `test -f ${shellQuote(path)} && echo 1 || echo 0`,

          `static-candidate:host:${path}`,

        );

        hit = out.trim() === "1";

      } else {

        const res = await commands.fileReadFile(LOCAL_CONNECTION_ID, path, 1);

        hit = res.status === "ok";
        const err = res.status === "error" ? res.error : undefined;
        redisConfigLog("probe.static.local", { path, hit, error: hit ? undefined : err });

      }

      redisConfigLog("probe.static.try", { path, hit });

      if (hit) return path;

    } catch (error) {

      redisConfigWarn("probe.static.try.failed", {

        path,

        error: error instanceof Error ? error.message : String(error),

      });

    }

  }

  redisConfigLog("probe.static.none");

  return null;

}



async function ensureSshSession(sshId: string): Promise<void> {

  redisConfigLog("ssh.ensure.start", { sshId });

  const ok = await ensureSshReady(sshId);

  redisConfigLog("ssh.ensure.result", { sshId, ok });

  if (!ok) {

    throw new Error("SSH 连接失败");

  }

}



function toRemoteDeployment(deployment: RedisDeploymentInfo): RemoteConfigDeployment {

  return {

    sshConnectionId: deployment.sshConnectionId,

    containerId: deployment.containerId,

  };

}



/** 查找 Redis 配置文件路径（主机：dir/redis.conf 或 pid 同目录；Docker：容器内探测）。 */
export async function findRedisConfigPath(
  connection: DbConnectionConfig,
  deployment: RedisDeploymentInfo,
): Promise<string | null> {
  redisConfigLog("find.start", {
    connection: `${connection.name || connection.host}:${connection.port}`,
    deployment: summarizeDeployment(deployment),
  });

  const installDir = await resolveLiveDir(connection, deployment);
  const sshId = deployment.sshConnectionId;
  const containerId = deployment.containerId;
  const pidFile = deployment.pidFile;

  if (sshId) {
    await ensureSshSession(sshId);
  } else {
    redisConfigWarn("find.no-ssh", { kind: deployment.kind });
  }

  if (sshId && containerId) {
    redisConfigLog("find.mode", { mode: "docker" });

    const installDirPath = await findConfigInInstallDir(sshId, containerId, installDir);
    if (installDirPath) {
      redisConfigLog("find.hit", { source: "docker-install-dir", path: installDirPath });
      return installDirPath;
    }

    const pidDirPath = await findConfigBesidePidFile(sshId, containerId, pidFile);
    if (pidDirPath) {
      redisConfigLog("find.hit", { source: "docker-pid-dir", path: pidDirPath });
      return pidDirPath;
    }

    const mountPath = await readConfigFromDockerMounts(sshId, containerId);

    if (mountPath) {

      redisConfigLog("find.hit", { source: "docker-mount", path: mountPath });

      return mountPath;

    }



    const cmdlinePath = await readConfigFromProcessCmdline(

      (script) =>

        sshExec(

          sshId,

          `docker exec ${shellQuote(containerId)} sh -c ${shellQuote(script)}`,

          "docker-cmdline",

        ),

      pidFile,

      "docker",

    );

    if (cmdlinePath && (await remotePathExists(sshId, cmdlinePath, containerId, "docker-cmdline"))) {

      redisConfigLog("find.hit", { source: "docker-cmdline", path: cmdlinePath });

      return cmdlinePath;

    }



    const dockerPath = await discoverConfigPath(

      (script) =>

        sshExec(

          sshId,

          `docker exec ${shellQuote(containerId)} sh -c ${shellQuote(script)}`,

          "docker-discover",

        ),

      "docker",

    );

    if (dockerPath && (await remotePathExists(sshId, dockerPath, containerId, "docker-discover"))) {

      redisConfigLog("find.hit", { source: "docker-discover", path: dockerPath });

      return dockerPath;

    }

  } else if (sshId) {
    redisConfigLog("find.mode", { mode: "host" });

    const installDirPath = await findConfigInInstallDir(sshId, undefined, installDir);
    if (installDirPath) {
      redisConfigLog("find.hit", { source: "host-install-dir", path: installDirPath });
      return installDirPath;
    }

    const pidDirPath = await findConfigBesidePidFile(sshId, undefined, pidFile);
    if (pidDirPath) {
      redisConfigLog("find.hit", { source: "host-pid-dir", path: pidDirPath });
      return pidDirPath;
    }

    const cmdlinePath = await readConfigFromProcessCmdline(

      (script) => sshExec(sshId, script, "host-cmdline"),

      pidFile,

      "host",

    );

    if (cmdlinePath && (await remotePathExists(sshId, cmdlinePath, undefined, "host-cmdline"))) {

      redisConfigLog("find.hit", { source: "host-cmdline", path: cmdlinePath });

      return cmdlinePath;

    }



    const hostPath = await discoverConfigPath(

      (script) => sshExec(sshId, script, "host-discover"),

      "host",

    );

    if (hostPath && (await remotePathExists(sshId, hostPath, undefined, "host-discover"))) {

      redisConfigLog("find.hit", { source: "host-discover", path: hostPath });

      return hostPath;

    }

  } else {

    redisConfigLog("find.mode", { mode: "local" });

  }



  const staticPath = await probeStaticCandidatePaths(sshId, containerId);

  if (staticPath) {

    redisConfigLog("find.hit", { source: "static-candidate", path: staticPath });

    return staticPath;

  }



  redisConfigWarn("find.miss", {
    deployment: summarizeDeployment(deployment),
    installDir: installDir || "(empty)",
    hint: "Set localStorage omnipanel-redis-config-debug=1 to keep logs in production builds",
  });
  return null;
}



/** 为指定 Redis 配置文件路径创建 TextEditorIO。 */

export function createRedisConfigTextIO(

  path: string,

  deployment: RedisDeploymentInfo,

): TextEditorIO {

  redisConfigLog("editor.create", { path, deployment: summarizeDeployment(deployment) });

  return createRemoteConfigTextIO(path, toRemoteDeployment(deployment));

}


