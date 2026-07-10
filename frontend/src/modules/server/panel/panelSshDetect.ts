import type { Connection } from "../../../ipc/bindings";
import {
  ensureSshReady,
  findSshConnectionForDbHost,
  hostsMatch,
} from "../../database/mysqlSlowQueryLog";
import { parseSshConfig } from "./serverConnection";

/** 从面板地址解析主机名（支持 URL、host:port）。 */
export function parsePanelAddressHost(address: string): string {
  const raw = address.trim();
  if (!raw) return "";

  try {
    const withProtocol = /^[a-z][a-z0-9+\-.]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    const url = new URL(withProtocol);
    return url.hostname.trim();
  } catch {
    const hostPart = raw.split("/")[0]?.trim() ?? "";
    if (!hostPart) return "";

    if (hostPart.startsWith("[") && hostPart.includes("]")) {
      return hostPart.slice(1, hostPart.indexOf("]")).trim();
    }

    const colon = hostPart.lastIndexOf(":");
    if (colon > 0 && /^\d+$/.test(hostPart.slice(colon + 1))) {
      return hostPart.slice(0, colon).trim();
    }

    return hostPart;
  }
}

export type PanelSshLinkStatus = {
  hostMatch: boolean;
  connected: boolean;
};

/** 按面板地址主机自动匹配 SSH 连接。 */
export async function detectPanelSshConnection(
  panelAddress: string,
  sshConnections: Connection[],
): Promise<Connection | null> {
  const host = parsePanelAddressHost(panelAddress);
  if (!host) return null;
  return (await findSshConnectionForDbHost(sshConnections, host)) ?? null;
}

/** 检测所选 SSH 与面板地址是否匹配，以及 SSH 是否已连接。 */
export async function probePanelSshLinkStatus(
  sshConnectionId: string,
  panelAddress: string,
  sshConnections: Connection[],
): Promise<PanelSshLinkStatus | null> {
  if (!sshConnectionId.trim()) return null;

  const panelHost = parsePanelAddressHost(panelAddress);
  const ssh = sshConnections.find((conn) => conn.id === sshConnectionId && conn.kind === "ssh");
  if (!ssh) {
    return { hostMatch: false, connected: false };
  }

  const cfg = parseSshConfig(ssh);
  const hostMatch = panelHost
    ? Boolean(cfg && hostsMatch(panelHost, cfg.host, cfg.publicIp))
    : false;

  let connected = false;
  try {
    connected = await ensureSshReady(sshConnectionId);
  } catch {
    connected = false;
  }

  return { hostMatch, connected };
}
