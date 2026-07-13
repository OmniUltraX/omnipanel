import type {
  DockerConnectionInfo,
  DockerContainerSummary,
  DockerImageSummary,
  DockerNetworkSummary,
  DockerVolumeSummary,
} from "../../ipc/bindings";
import { hasSidebarTreeSearch, sidebarTreeSearchMatches } from "../../lib/sidebarTreeSearch";
import { dockerSourceLabel } from "./dockerConnectionSource";
import {
  containerRowLabel,
  imageRowLabel,
  imageRowSizeLabel,
  networkRowLabel,
  volumeRowLabel,
} from "./dockerResourceLabels";
import type { DockerTreeCategory } from "./dockerSidebarNav";
import type { DockerServiceGroup } from "@/stores/dockerServiceGroupStore";

export function dockerImageMatchesSearch(query: string, image: DockerImageSummary): boolean {
  return sidebarTreeSearchMatches(
    query,
    imageRowLabel(image),
    image.repository,
    image.tag,
    image.shortId,
    image.id,
    imageRowSizeLabel(image),
  );
}

export function dockerContainerMatchesSearch(query: string, container: DockerContainerSummary): boolean {
  return sidebarTreeSearchMatches(
    query,
    containerRowLabel(container),
    container.name,
    container.image,
    container.shortId,
    container.id,
  );
}

export function dockerNetworkMatchesSearch(query: string, network: DockerNetworkSummary): boolean {
  return sidebarTreeSearchMatches(
    query,
    networkRowLabel(network),
    network.name,
    network.driver,
    network.id,
  );
}

export function dockerVolumeMatchesSearch(query: string, volume: DockerVolumeSummary): boolean {
  return sidebarTreeSearchMatches(
    query,
    volumeRowLabel(volume),
    volume.name,
    volume.driver,
  );
}

export function dockerServiceGroupMatchesSearch(
  query: string,
  group: DockerServiceGroup,
  groupContainers: DockerContainerSummary[],
): boolean {
  if (sidebarTreeSearchMatches(query, group.name)) {
    return true;
  }
  return groupContainers.some((container) => dockerContainerMatchesSearch(query, container));
}

export function dockerConnectionSubtreeMatchesSearch(
  query: string,
  connection: DockerConnectionInfo,
  resources: {
    images: DockerImageSummary[];
    containers: DockerContainerSummary[];
    networks: DockerNetworkSummary[];
    volumes: DockerVolumeSummary[];
  },
  categoryLabels: Record<DockerTreeCategory, string>,
  serviceGroups: DockerServiceGroup[],
): boolean {
  if (!hasSidebarTreeSearch(query)) {
    return true;
  }
  if (sidebarTreeSearchMatches(query, connection.name, dockerSourceLabel(connection.source))) {
    return true;
  }
  for (const label of Object.values(categoryLabels)) {
    if (sidebarTreeSearchMatches(query, label)) {
      return true;
    }
  }
  if (resources.images.some((image) => dockerImageMatchesSearch(query, image))) {
    return true;
  }
  if (resources.containers.some((container) => dockerContainerMatchesSearch(query, container))) {
    return true;
  }
  if (resources.networks.some((network) => dockerNetworkMatchesSearch(query, network))) {
    return true;
  }
  if (resources.volumes.some((volume) => dockerVolumeMatchesSearch(query, volume))) {
    return true;
  }
  for (const group of serviceGroups) {
    const groupContainers = group.containerIds
      .map((id) => resources.containers.find((container) => container.id === id))
      .filter((item): item is DockerContainerSummary => item != null);
    if (dockerServiceGroupMatchesSearch(query, group, groupContainers)) {
      return true;
    }
  }
  return false;
}

export function dockerConnectionNameMatchesSearch(
  query: string,
  connection: DockerConnectionInfo,
): boolean {
  return sidebarTreeSearchMatches(query, connection.name, dockerSourceLabel(connection.source));
}
