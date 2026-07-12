import type { SftpEntry } from "./sftpUtils";

export type SftpPanelCapabilities = {
  mkdir: boolean;
  delete: boolean;
  rename: boolean;
  chmod: boolean;
  preview: boolean;
};

export const SFTP_DEFAULT_CAPABILITIES: SftpPanelCapabilities = {
  mkdir: true,
  delete: true,
  rename: true,
  chmod: true,
  preview: true,
};

export type SftpPanelAdapter = {
  list: (path: string) => Promise<SftpEntry[]>;
  remove?: (path: string) => Promise<void>;
  mkdir?: (path: string) => Promise<void>;
  rename?: (oldPath: string, newPath: string) => Promise<void>;
  chmod?: (path: string, mode: number) => Promise<void>;
  readBytes?: (path: string, maxBytes: number) => Promise<number[]>;
  writeBytes?: (path: string, bytes: number[]) => Promise<void>;
  capabilities?: Partial<SftpPanelCapabilities>;
  emptyMessage?: string;
};

export function resolveSftpCapabilities(
  adapter?: SftpPanelAdapter,
): SftpPanelCapabilities {
  if (!adapter) {
    return SFTP_DEFAULT_CAPABILITIES;
  }
  const caps = adapter.capabilities ?? {};
  return {
    mkdir: caps.mkdir ?? Boolean(adapter.mkdir),
    delete: caps.delete ?? Boolean(adapter.remove),
    rename: caps.rename ?? Boolean(adapter.rename),
    chmod: caps.chmod ?? Boolean(adapter.chmod),
    preview: caps.preview ?? Boolean(adapter.readBytes),
  };
}
