import type { Connection, PanelProbeItem } from "@/ipc/bindings";

import { parseSshConfig } from "./serverConnection";

/** 将 1Panel / 宝塔安全入口路径拼入面板 origin（若尚未包含）。 */
export function appendPanelEntrance(baseUrl: string, entrance: string | undefined): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) return "";
  const ent = entrance?.trim();
  if (!ent) return trimmed.replace(/\/$/, "");

  const path = ent.startsWith("/") ? ent : `/${ent}`;
  const pathNorm = path.replace(/\/$/, "");

  try {
    const u = new URL(trimmed);
    const current = u.pathname.replace(/\/$/, "") || "";
    if (current === pathNorm || current.endsWith(pathNorm)) {
      return trimmed.replace(/\/$/, "");
    }
    if (!current || current === "/") {
      u.pathname = pathNorm;
      return u.toString().replace(/\/$/, "");
    }
  } catch {
    const base = trimmed.replace(/\/$/, "");
    if (base.endsWith(pathNorm)) return base;
    return `${base}${pathNorm}`;
  }

  return trimmed.replace(/\/$/, "");
}

/** 探测结果 → 客户端可达的面板 baseUrl（公网 IP + 安全入口）。 */
export function panelProbeReachableAddress(
  panel: PanelProbeItem,
  ssh: Connection | null,
): string {
  if (!panel.address) return "";
  const cfg = ssh ? parseSshConfig(ssh) : null;
  const host = (cfg?.publicIp || cfg?.host || "").trim();
  let addr = panel.address;
  if (host) {
    addr = addr.replace("127.0.0.1", host);
  }
  return appendPanelEntrance(addr, panel.entrance);
}
