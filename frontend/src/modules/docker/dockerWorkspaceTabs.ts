import { useMemo } from "react";
import { useI18n } from "../../i18n";
import type { TopbarTabDef } from "../../stores/topbarStore";

export type DockerWorkspaceTab =
  | "containers"
  | "images"
  | "compose"
  | "networks"
  | "volumes"
  | "files"
  | "swarm";

export const DOCKER_WORKSPACE_TABS: DockerWorkspaceTab[] = [
  "containers",
  "images",
  "compose",
  "networks",
  "volumes",
  "files",
  "swarm",
];

export function useDockerWorkspaceTabs(activeTab: DockerWorkspaceTab): TopbarTabDef[] {
  const { t } = useI18n();

  return useMemo(
    () =>
      DOCKER_WORKSPACE_TABS.map((id) => ({
        id,
        label: t(`docker.tabs.${id}`),
        active: activeTab === id,
      })),
    [activeTab, t],
  );
}
