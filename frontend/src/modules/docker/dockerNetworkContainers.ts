import type { DockerContainerSummary, DockerNetworkSummary } from "../../ipc/bindings";
import { containerRowLabel } from "./dockerResourceLabels";

/** 按网络名称聚合已连接容器。 */
export function groupContainersByNetworkName(
  networks: DockerNetworkSummary[],
  containers: DockerContainerSummary[],
): Map<string, DockerContainerSummary[]> {
  const result = new Map<string, DockerContainerSummary[]>();

  for (const network of networks) {
    const name = network.name.trim();
    if (!name) continue;
    const matched = containers.filter((container) =>
      container.networks.some((item) => item.trim() === name),
    );
    matched.sort((a, b) =>
      containerRowLabel(a).localeCompare(containerRowLabel(b), undefined, {
        sensitivity: "base",
        numeric: true,
      }),
    );
    result.set(name, matched);
  }

  return result;
}

export function containersForNetwork(
  network: DockerNetworkSummary,
  index: Map<string, DockerContainerSummary[]>,
): DockerContainerSummary[] {
  return index.get(network.name.trim()) ?? [];
}

export function networkContainerTagsCopyValue(containers: DockerContainerSummary[]): string {
  if (containers.length === 0) return "—";
  return containers.map((container) => containerRowLabel(container)).join(", ");
}
