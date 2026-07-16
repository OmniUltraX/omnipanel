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
  };
}
