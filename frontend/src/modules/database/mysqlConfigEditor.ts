import { commands } from "../../ipc/bindings";
import { LOCAL_CONNECTION_ID } from "../files/utils";
import type { MysqlDeploymentInfo } from "./mysqlDeploymentDetect";

const MAX_CONFIG_BYTES = 512 * 1024;

const CONFIG_CANDIDATES = [
  "/etc/my.cnf",
  "/etc/mysql/my.cnf",
];

function bytesToString(bytes: number[]): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
}

function stringToBytes(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}

async function sshExec(sshId: string, command: string): Promise<string> {
  const res = await commands.sshPoolExecCommand(sshId, command);
  if (res.status !== "ok") {
    throw new Error(res.error?.message ?? "SSH 执行失败");
  }
  return res.data.stdout;
}

/**
 * 查找第一个存在的 MySQL 配置文件路径。
 */
export async function findMysqlConfigPath(
  deployment: MysqlDeploymentInfo,
): Promise<string | null> {
  const sshId = deployment.sshConnectionId;
  const containerId = deployment.containerId;

  for (const path of CONFIG_CANDIDATES) {
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
          `test -f '${path}' && echo 1 || echo 0`,
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

/**
 * 读取 MySQL 配置文件内容。
 */
export async function readMysqlConfig(
  path: string,
  deployment: MysqlDeploymentInfo,
): Promise<string> {
  const sshId = deployment.sshConnectionId;
  const containerId = deployment.containerId;

  if (sshId && containerId) {
    return await sshExec(
      sshId,
      `docker exec ${containerId} cat '${path}'`,
    );
  }
  if (sshId) {
    const res = await commands.sftpDownload(sshId, path);
    if (res.status !== "ok" || !res.data) {
      throw new Error(res.error?.message ?? "读取配置文件失败");
    }
    return bytesToString(res.data);
  }
  const res = await commands.fileReadFile(LOCAL_CONNECTION_ID, path, MAX_CONFIG_BYTES);
  if (res.status !== "ok" || !res.data) {
    throw new Error(res.error?.message ?? "读取配置文件失败");
  }
  return bytesToString(res.data);
}

/**
 * 写入 MySQL 配置文件。
 */
export async function writeMysqlConfig(
  path: string,
  content: string,
  deployment: MysqlDeploymentInfo,
): Promise<void> {
  const sshId = deployment.sshConnectionId;
  const containerId = deployment.containerId;

  if (sshId && containerId) {
    const tmpPath = `/tmp/omnipanel_mysql_cnf_${Date.now()}`;
    const data = stringToBytes(content);

    const uploadRes = await commands.sftpUpload(sshId, tmpPath, data);
    if (uploadRes.status !== "ok") {
      throw new Error(uploadRes.error?.message ?? "上传临时文件失败");
    }

    await sshExec(sshId, `docker cp '${tmpPath}' ${containerId}:'${path}'`);

    await sshExec(sshId, `rm -f '${tmpPath}'`);
    return;
  }

  if (sshId) {
    const data = stringToBytes(content);
    const res = await commands.sftpUpload(sshId, path, data);
    if (res.status !== "ok") {
      throw new Error(res.error?.message ?? "写入配置文件失败");
    }
    return;
  }

  const res = await commands.writeTextFile(path, content);
  if (res.status !== "ok") {
    throw new Error(res.error ?? "写入配置文件失败");
  }
}
