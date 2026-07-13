import type {
  DockerContainerSummary,
  DockerImageSummary,
  DockerNetworkSummary,
  DockerVolumeSummary,
} from "../../ipc/bindings";
import { formatBytes } from "../../stores/sshStatsStore";
import type { DockerTreeCategory } from "./dockerSidebarNav";

export function makeDockerTreeKey(
  connectionId: string,
  category?: DockerTreeCategory,
  itemId?: string,
): string {
  if (!category) return `docker:${connectionId}`;
  if (!itemId) return `docker:${connectionId}:${category}`;
  return `docker:${connectionId}:${category}:${itemId}`;
}

export function makeDockerServiceGroupTreeKey(connectionId: string, groupId: string): string {
  return `docker:${connectionId}:containers:group:${groupId}`;
}

export function parseDockerServiceGroupTreeKey(
  key: string | null | undefined,
): { connectionId: string; groupId: string } | null {
  if (!key) return null;
  const match = /^docker:([^:]+):containers:group:([^:]+)$/.exec(key);
  if (!match) return null;
  return { connectionId: match[1], groupId: match[2] };
}

export function imageRowLabel(image: DockerImageSummary): string {
  const ref =
    image.repository && image.tag ? `${image.repository}:${image.tag}` : image.repository || image.tag;
  if (ref && ref !== ":") return ref;
  return image.shortId || image.id.slice(0, 12) || "—";
}

export function imageRowSizeLabel(image: DockerImageSummary): string {
  return formatBytes(image.sizeBytes);
}

export function containerRowLabel(container: DockerContainerSummary): string {
  return container.name || container.shortId || container.id.slice(0, 12) || "—";
}

export function networkRowLabel(network: DockerNetworkSummary): string {
  return network.name || network.id.slice(0, 12) || "—";
}

export function volumeRowLabel(volume: DockerVolumeSummary): string {
  return volume.name || "—";
}