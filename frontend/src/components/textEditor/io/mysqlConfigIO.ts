import { commands } from "../../../ipc/bindings";
import { LOCAL_CONNECTION_ID } from "../../../modules/files/utils";
import type { MysqlDeploymentInfo } from "../../../modules/database/mysqlDeploymentDetect";
import { ensureSshReady } from "../../../modules/database/mysqlSlowQueryLog";
import type { TextEditorIO } from "../types";
import { decodeUtf8, encodeUtf8 } from "../bytes";

const MAX_CONFIG_BYTES = 512 * 1024;

/** 常见 MySQL 配置路径（Linux / macOS / 官方 Docker 镜像）。 */
export const MYSQL_CONFIG_CANDIDATES = [
  "/etc/my.cnf",
  "/etc/mysql/my.cnf",
  "/etc/mysql/mysql.conf.d/mysqld.cnf",
  "/etc/mysql/conf.d/mysql.cnf",
  "/etc/mysql/conf.d/mysqld.cnf",
  "/usr/local/etc/my.cnf",
  "/opt/homebrew/etc/my.cnf",
  "/etc/mysql.cnf",
];

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function sshExec(sshId: string, command: string): Promise<string> {
  const res = await commands.sshPoolExecCommand(sshId, command);
  if (res.status !== "ok") {
    const err = res.error;
    const message =
      typeof err === "string"
        ? err
        : err && typeof err === "object" && "message" in err
          ? String((err as { message?: string }).message)
          : "SSH 执行失败";
    throw new Error(message);
  }
  return res.data.stdout;
}

function buildDiscoverConfigCommand(): string {
  const paths = MYSQL_CONFIG_CANDIDATES.join(" ");
  return [
    `for p in ${paths}; do if [ -f "$p" ]; then printf '%s' "$p"; exit 0; fi; done`,
    `found=$(find /etc /usr/local/etc /opt/homebrew/etc -maxdepth 6 \\( -name my.cnf -o -name mysqld.cnf \\) 2>/dev/null | head -1)`,
    `if [ -n "$found" ] && [ -f "$found" ]; then printf '%s' "$found"; exit 0; fi`,
    `exit 1`,
  ].join("; ");
}

async function discoverConfigPath(
  runShell: (script: string) => Promise<string>,
): Promise<string | null> {
  try {
    const out = (await runShell(buildDiscoverConfigCommand())).trim();
    if (!out) return null;
    const line = out.split("\n").map((s) => s.trim()).find(Boolean);
    return line ?? null;
  } catch {
    return null;
  }
}

async function probeStaticCandidatePaths(
  sshId: string | undefined,
  containerId: string | undefined,
): Promise<string | null> {
  for (const path of MYSQL_CONFIG_CANDIDATES) {
    try {
      if (sshId && containerId) {
        const out = await sshExec(
          sshId,
          `docker exec ${containerId} sh -c "test -f '${path}' && echo 1 || echo 0" 2>/dev/null`,
        );
        if (out.trim() === "1") return path;
      } else if (sshId) {
        const out = await sshExec(
          sshId,
          `test -f ${shellQuote(path)} && echo 1 || echo 0`,
        );
        if (out.trim() === "1") return path;
      } else {
        const res = await commands.fileReadFile(LOCAL_CONNECTION_ID, path, 1);
        if (res.status === "ok") return path;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

async function ensureSshSession(sshId: string): Promise<void> {
  const ok = await ensureSshReady(sshId);
  if (!ok) {
    throw new Error("SSH 连接失败");
  }
}

/** 查找第一个存在的 MySQL 配置文件路径。 */
export async function findMysqlConfigPath(
  deployment: MysqlDeploymentInfo,
): Promise<string | null> {
  const sshId = deployment.sshConnectionId;
  const containerId = deployment.containerId;

  if (sshId) {
    await ensureSshSession(sshId);
  }

  if (sshId && containerId) {
    const dockerPath = await discoverConfigPath((script) =>
      sshExec(
        sshId,
        `docker exec ${containerId} sh -c ${shellQuote(script)}`,
      ),
    );
    if (dockerPath) return dockerPath;
  } else if (sshId) {
    const hostPath = await discoverConfigPath((script) => sshExec(sshId, script));
    if (hostPath) return hostPath;
  }

  return probeStaticCandidatePaths(sshId, containerId);
}

/** 为指定 MySQL 配置文件路径创建 TextEditorIO。 */
export function createMysqlConfigTextIO(
  path: string,
  deployment: MysqlDeploymentInfo,
): TextEditorIO {
  const sshId = deployment.sshConnectionId;
  const containerId = deployment.containerId;

  return {
    readText: async () => {
      if (sshId) {
        await ensureSshSession(sshId);
      }
      if (sshId && containerId) {
        return await sshExec(sshId, `docker exec ${containerId} cat ${shellQuote(path)}`);
      }
      if (sshId) {
        const res = await commands.sftpDownload(sshId, path);
        if (res.status !== "ok" || !res.data) {
          throw new Error(
            typeof res.error === "string"
              ? res.error
              : res.error?.message ?? "读取配置文件失败",
          );
        }
        return decodeUtf8(res.data);
      }
      const res = await commands.fileReadFile(LOCAL_CONNECTION_ID, path, MAX_CONFIG_BYTES);
      if (res.status !== "ok" || !res.data) {
        throw new Error(
          typeof res.error === "string"
            ? res.error
            : res.error?.message ?? "读取配置文件失败",
        );
      }
      return decodeUtf8(res.data);
    },
    writeText: async (content) => {
      if (sshId) {
        await ensureSshSession(sshId);
      }
      if (sshId && containerId) {
        const tmpPath = `/tmp/omnipanel_mysql_cnf_${Date.now()}`;
        const data = encodeUtf8(content);
        const uploadRes = await commands.sftpUpload(sshId, tmpPath, data);
        if (uploadRes.status !== "ok") {
          throw new Error(uploadRes.error?.message ?? "上传临时文件失败");
        }
        await sshExec(
          sshId,
          `docker cp ${shellQuote(tmpPath)} ${containerId}:${shellQuote(path)}`,
        );
        await sshExec(sshId, `rm -f ${shellQuote(tmpPath)}`);
        return;
      }
      if (sshId) {
        const res = await commands.sftpUpload(sshId, path, encodeUtf8(content));
        if (res.status !== "ok") {
          throw new Error(res.error?.message ?? "写入配置文件失败");
        }
        return;
      }
      const res = await commands.writeTextFile(path, content);
      if (res.status !== "ok") {
        throw new Error(typeof res.error === "string" ? res.error : "写入配置文件失败");
      }
    },
  };
}
