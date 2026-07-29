import type { SftpPanelAdapter } from "../../../components/sftp/sftpAdapter";
import type { SftpEntry } from "../../../components/sftp/sftpUtils";
import { createBtPanelClient } from "../../../lib/btpanel";
import type { ServerEntry } from "./serverConnection";

function parseBtDirItem(raw: string, isDir: boolean): SftpEntry | null {
  const parts = raw.split(";");
  const name = parts[0]?.trim();
  if (!name || name === "." || name === "..") return null;
  const size = Number(parts[1] ?? 0);
  return {
    name,
    isDir,
    isSymlink: false,
    linkTarget: null,
    size: Number.isFinite(size) ? size : 0,
  };
}

/** 通过宝塔文件 API 浏览宿主机目录（用于网站站点路径）。 */
export function makeBtPanelSftpAdapter(server: ServerEntry): SftpPanelAdapter {
  const client = createBtPanelClient(server.address, server.key);

  return {
    capabilities: {
      mkdir: false,
      delete: false,
      rename: false,
      chmod: false,
      preview: true,
    },
    list: async (path) => {
      const result = await client.getDir(path || "/");
      const dirs = (result.DIR ?? [])
        .map((item) => parseBtDirItem(item, true))
        .filter((item): item is SftpEntry => item != null);
      const files = (result.FILES ?? [])
        .map((item) => parseBtDirItem(item, false))
        .filter((item): item is SftpEntry => item != null);
      const entries = [...dirs, ...files];
      entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return entries;
    },
    readBytes: async (path, maxBytes) => {
      const body = await client.getFileBody(path);
      const text = typeof body.data === "string" ? body.data : "";
      const encoder = new TextEncoder();
      const bytes = encoder.encode(text);
      const sliced = bytes.length > maxBytes ? bytes.slice(0, maxBytes) : bytes;
      return Array.from(sliced);
    },
    writeBytes: async (path, bytes) => {
      const decoder = new TextDecoder();
      const text = decoder.decode(Uint8Array.from(bytes));
      await client.saveFileBody(path, text);
    },
  };
}
