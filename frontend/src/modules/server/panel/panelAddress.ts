import type { Connection, PanelProbeItem } from "@/ipc/bindings";

import { parseSshConfig } from "./serverConnection";

/** 去掉路径，只保留 scheme://host:port（API 不含安全入口）。 */
export function stripPanelUrlToOrigin(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const u = new URL(withScheme);
    return `${u.protocol}//${u.host}`;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

/** 将 1Panel / 宝塔安全入口路径拼入面板 origin（若尚未包含）。仅用于浏览器打开。 */
export function appendPanelEntrance(baseUrl: string, entrance: string | undefined): string {
  const trimmed = stripPanelUrlToOrigin(baseUrl);
  if (!trimmed) return "";
  const ent = entrance?.trim();
  if (!ent) return trimmed;

  const path = ent.startsWith("/") ? ent : `/${ent}`;
  const pathNorm = path.replace(/\/$/, "");

  try {
    const u = new URL(trimmed);
    u.pathname = pathNorm;
    return u.toString().replace(/\/$/, "");
  } catch {
    return `${trimmed}${pathNorm}`;
  }
}

function replaceLoopbackHost(address: string, ssh: Connection | null): string {
  if (!address) return "";
  const cfg = ssh ? parseSshConfig(ssh) : null;
  const host = (cfg?.publicIp || cfg?.host || "").trim();
  if (!host) return address;
  return address.replace("127.0.0.1", host);
}

/** 探测结果 → 面板 API origin（公网 IP + 端口，不含安全入口）。 */
export function panelProbeReachableAddress(
  panel: PanelProbeItem,
  ssh: Connection | null,
): string {
  return stripPanelUrlToOrigin(replaceLoopbackHost(panel.address, ssh));
}

/** 探测结果 → 浏览器安全入口 URL（origin + entrance）。 */
export function panelProbeBrowserUrl(
  panel: PanelProbeItem,
  ssh: Connection | null,
): string {
  return appendPanelEntrance(panelProbeReachableAddress(panel, ssh), panel.entrance);
}
