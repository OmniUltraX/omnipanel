import { commands } from "../../../ipc/bindings";
import { LOCAL_CONNECTION_ID } from "../../../modules/files/utils";
import { ensureSshReady } from "../../../modules/database/mysqlSlowQueryLog";
import type { TextEditorIO } from "../types";
import { decodeUtf8, encodeUtf8 } from "../bytes";

const MAX_CONFIG_BYTES = 512 * 1024;

export interface RemoteConfigDeployment {
  sshConnectionId?: string;
  containerId?: string;
}

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

async function ensureSshSession(sshId: string): Promise<void> {
  const ok = await ensureSshReady(sshId);
  if (!ok) {
    throw new Error("SSH 连接失败");
  }
}

/** 为远程配置文件路径创建 TextEditorIO（SSH 主机 / Docker 容器 / 本机）。 */
export function createRemoteConfigTextIO(
  path: string,
  deployment: RemoteConfigDeployment,
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
        const tmpPath = `/tmp/omnipanel_remote_cnf_${Date.now()}`;
        const uploadRes = await commands.sftpUpload(sshId, tmpPath, encodeUtf8(content));
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
