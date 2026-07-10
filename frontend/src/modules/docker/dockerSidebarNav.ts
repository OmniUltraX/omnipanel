import type { DockerConnectionDockOpenMode } from "./dockerConnectionWorkspaceTabs";

export type DockerTreeCategory = "images" | "containers" | "networks" | "volumes";
export const DOCKER_TREE_CATEGORIES: DockerTreeCategory[] = [
  "images",
  "containers",
  "networks",
  "volumes",
];

export type DockerSidebarNavTarget = {  connectionId: string;
  category?: DockerTreeCategory;
  itemId?: string;
};

export type DockerSidebarNavigate = (
  target: DockerSidebarNavTarget,
  mode?: DockerConnectionDockOpenMode,
) => void;
