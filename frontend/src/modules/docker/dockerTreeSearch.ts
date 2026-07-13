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
    container.composeProject,
    container.composeService,
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

export function dockerComposeProjectMatchesSearch(
  query: string,
  project: string,
  projectContainers: DockerContainerSummary[],
): boolean {
  if (sidebarTreeSearchMatches(query, project)) {
    return true;
  }
  return projectContainers.some((container) => dockerContainerMatchesSearch(query, container));
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
  const composeProjects = new Map<string, DockerContainerSummary[]>();
  for (const container of resources.containers) {
    const project = container.composeProject?.trim();
    if (!project) continue;
    const bucket = composeProjects.get(project);
    if (bucket) {
      bucket.push(container);
    } else {
      composeProjects.set(project, [container]);
    }
  }
  for (const [project, projectContainers] of composeProjects) {
    if (dockerComposeProjectMatchesSearch(query, project, projectContainers)) {
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
