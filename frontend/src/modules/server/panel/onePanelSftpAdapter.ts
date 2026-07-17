import type { SftpPanelAdapter } from "../../../components/sftp/sftpAdapter";
import type { SftpEntry } from "../../../components/sftp/sftpUtils";
import { createOnePanelClient } from "../../../lib/onepanel";
import type { ServerEntry } from "./serverConnection";

function toSftpEntry(entry: {
  name: string;
  isDir: boolean;
  isSymlink: boolean;
  linkTarget: string | null;
  size: number;
}): SftpEntry {
  return {
    name: entry.name,
    isDir: entry.isDir,
    isSymlink: entry.isSymlink,
    linkTarget: entry.linkTarget,
    size: entry.size,
  };
}

function splitRemoteFilePath(fullPath: string): { dir: string; name: string } {
  const normalized = fullPath.replace(/\/+$/, "") || "/";
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) {
    return { dir: "/", name: normalized.replace(/^\//, "") || normalized };
  }
  return {
    dir: normalized.slice(0, idx) || "/",
    name: normalized.slice(idx + 1),
  };
}

function bytesToBase64(bytes: number[]): string {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.slice(i, i + chunk);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

/** 通过 1Panel 文件 API 浏览宿主机目录（用于网站站点路径）。 */
export function makeOnePanelSftpAdapter(server: ServerEntry): SftpPanelAdapter {
  const client = createOnePanelClient(server.address, server.key);

  return {
    capabilities: {
      mkdir: false,
      delete: false,
      rename: false,
      chmod: false,
      preview: true,
    },
    list: async (path) => {
      const entries = await client.searchFiles(path);
      const normalized = entries.map(toSftpEntry);
      normalized.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return normalized;
    },
    readBytes: async (path, maxBytes) => {
      const text = await client.getFileContent(path);
      const encoder = new TextEncoder();
      const bytes = encoder.encode(text);
      const sliced = bytes.length > maxBytes ? bytes.slice(0, maxBytes) : bytes;
      return Array.from(sliced);
    },
    writeBytes: async (path, bytes) => {
      const { dir, name } = splitRemoteFilePath(path);
      if (!name) {
        throw new Error("无效的文件路径");
      }
      await client.uploadFile({
        path: dir,
        filename: name,
        contentBase64: bytesToBase64(bytes),
        overwrite: true,
      });
    },
  };
}
