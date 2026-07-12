import type { DockerContainerSummary, DockerPort } from "../../ipc/bindings";

/** 判断字符串是否像 IP 地址（避免误当作网络名展示）。 */
export function isLikelyIpAddress(value: string | null | undefined): boolean {
  const text = value?.trim();
  if (!text) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?$/.test(text)) return true;
  if (text.includes(":") && /^[0-9a-fA-F:.]+$/.test(text)) return true;
  return false;
}

export function formatDockerPort(port: DockerPort): string {
  const proto = port.protocol || "tcp";
  if (port.publicPort != null) {
    const hostIp = port.ip?.trim();
    const host = hostIp && hostIp !== "0.0.0.0" && hostIp !== "::" ? `${hostIp}:` : "";
    return `${host}${port.publicPort}->${port.privatePort}/${proto}`;
  }
  return `${port.privatePort}/${proto}`;
}

export function formatDockerPorts(container: DockerContainerSummary): string | null {
  if (!container.ports.length) return null;
  return container.ports.map(formatDockerPort).join(", ");
}

export function formatDockerNetworks(container: DockerContainerSummary): string | null {
  const names = new Set<string>();

  for (const item of container.networkAttachments ?? []) {
    const name = item.name?.trim();
    if (name && !isLikelyIpAddress(name)) {
      names.add(name);
    }
  }

  for (const item of container.networks) {
    const name = item.trim();
    if (name && !isLikelyIpAddress(name)) {
      names.add(name);
    }
  }

  if (names.size === 0) return null;
  return [...names].join(", ");
}

export function formatDockerIpAddress(container: DockerContainerSummary): string | null {
  const direct = container.ipAddress?.trim();
  if (direct) return direct;
  const fromAttachment = container.networkAttachments
    ?.map((item) => item.ipAddress?.trim())
    .find(Boolean);
  if (fromAttachment) return fromAttachment;
  const ipFromNetworks = container.networks.find((item) => isLikelyIpAddress(item));
  return ipFromNetworks?.trim() ?? null;
}

export function displayValue(value: string | null | undefined): string {
  const text = value?.trim();
  return text ? text : "—";
}
