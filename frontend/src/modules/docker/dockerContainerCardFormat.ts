import type { DockerContainerSummary, DockerPort } from "../../ipc/bindings";

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
  if (container.networkAttachments?.length) {
    const labels = container.networkAttachments
      .map((item) => {
        const ip = item.ipAddress?.trim();
        return ip ? `${item.name} (${ip})` : item.name;
      })
      .filter(Boolean);
    if (labels.length) return labels.join(", ");
  }
  if (container.networks.length) {
    return container.networks.join(", ");
  }
  return null;
}

export function formatDockerIpAddress(container: DockerContainerSummary): string | null {
  const direct = container.ipAddress?.trim();
  if (direct) return direct;
  const fromAttachment = container.networkAttachments?.find((item) => item.ipAddress?.trim())?.ipAddress?.trim();
  return fromAttachment ?? null;
}

export function displayValue(value: string | null | undefined): string {
  const text = value?.trim();
  return text ? text : "—";
}
