import type { DockerContainerSummary } from "../../ipc/bindings";

export interface DockerComposeProjectGroup {
  project: string;
  containers: DockerContainerSummary[];
}

export function resolveComposeProjectName(container: DockerContainerSummary): string | null {
  const project = container.composeProject?.trim();
  return project ? project : null;
}

export function groupContainersByComposeProject(
  containers: DockerContainerSummary[],
): DockerComposeProjectGroup[] {
  const map = new Map<string, DockerContainerSummary[]>();

  for (const container of containers) {
    const project = resolveComposeProjectName(container);
    if (!project) continue;
    const bucket = map.get(project);
    if (bucket) {
      bucket.push(container);
    } else {
      map.set(project, [container]);
    }
  }

  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }))
    .map(([project, groupContainers]) => ({
      project,
      containers: [...groupContainers].sort((a, b) =>
        (a.composeService ?? a.name).localeCompare(b.composeService ?? b.name, undefined, {
          sensitivity: "base",
          numeric: true,
        }),
      ),
    }));
}
