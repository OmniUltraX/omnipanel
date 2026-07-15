import { useCallback, useMemo } from "react";
import { useI18n } from "@/i18n";
import { SidebarTreeEmpty, SidebarTreeNode } from "@/components/ui/sidebar-tree";
import type { DockerConnectionInfo, DockerContainerSummary } from "@/ipc/bindings";
import type { DockerConnectionDockOpenMode } from "./dockerConnectionWorkspaceTabs";
import {
  containerRowLabel,
  makeDockerComposeProjectTreeKey,
  makeDockerTreeKey,
} from "./dockerResourceLabels";
import type { DockerSidebarNavigate } from "./dockerSidebarNav";
import { groupContainersByComposeProject, resolveComposeProjectName } from "./dockerComposeGroups";
import { DockerTreeIcon, dockerTreeNodeClassName } from "./dockerTreeIcons";
import { DockerTreeRefreshButton } from "./DockerTreeRefreshButton";
import { DockerSidebarExpandableLeaves } from "./DockerSidebarExpandableLeaves";
import {
  dockerComposeProjectMatchesSearch,
  dockerContainerMatchesSearch,
} from "./dockerTreeSearch";
import { hasSidebarTreeSearch, sidebarTreeSearchMatches } from "@/lib/sidebarTreeSearch";
import { dockerSidebarCategoryRefreshKey } from "./dockerSidebarCache";

type DockerContainersTreeBranchProps = {
  connection: DockerConnectionInfo;
  containers: DockerContainerSummary[];
  activeNavKey: string | null;
  searchQuery: string;
  connectionNameMatch: boolean;
  loading: boolean;
  error: string | null;
  isExpanded: (key: string) => boolean;
  toggle: (key: string) => void;
  ensureExpanded: (key: string) => void;
  onNavigate: DockerSidebarNavigate;
  onRefreshCategory: () => void;
};

export function DockerContainersTreeBranch({
  connection,
  containers,
  activeNavKey,
  searchQuery,
  connectionNameMatch,
  loading,
  error,
  isExpanded,
  toggle,
  ensureExpanded,
  onNavigate,
  onRefreshCategory,
}: DockerContainersTreeBranchProps) {
  const { t } = useI18n();

  const composeProjectGroups = useMemo(
    () =>
      groupContainersByComposeProject(
        containers.filter((container) => resolveComposeProjectName(container) != null),
      ),
    [containers],
  );

  const standaloneContainers = useMemo(
    () => containers.filter((container) => resolveComposeProjectName(container) == null),
    [containers],
  );

  const visibleComposeProjects = useMemo(() => {
    if (!hasSidebarTreeSearch(searchQuery) || connectionNameMatch) {
      return composeProjectGroups;
    }
    if (sidebarTreeSearchMatches(searchQuery, t("docker.tabs.containers"))) {
      return composeProjectGroups;
    }
    return composeProjectGroups.filter((group) =>
      dockerComposeProjectMatchesSearch(searchQuery, group.project, group.containers),
    );
  }, [composeProjectGroups, connectionNameMatch, searchQuery, t]);

  const visibleStandaloneContainers = useMemo(() => {
    if (!hasSidebarTreeSearch(searchQuery) || connectionNameMatch) {
      return standaloneContainers;
    }
    if (sidebarTreeSearchMatches(searchQuery, t("docker.tabs.containers"))) {
      return standaloneContainers;
    }
    return standaloneContainers.filter((container) => dockerContainerMatchesSearch(searchQuery, container));
  }, [connectionNameMatch, searchQuery, standaloneContainers, t]);

  const filterComposeProjectContainers = useCallback(
    (projectContainers: DockerContainerSummary[]) => {
      if (!hasSidebarTreeSearch(searchQuery) || connectionNameMatch) {
        return projectContainers;
      }
      if (sidebarTreeSearchMatches(searchQuery, t("docker.tabs.containers"))) {
        return projectContainers;
      }
      return projectContainers.filter((container) => dockerContainerMatchesSearch(searchQuery, container));
    },
    [connectionNameMatch, searchQuery, t],
  );

  const openComposeProject = (project: string, mode?: DockerConnectionDockOpenMode) => {
    ensureExpanded(makeDockerTreeKey(connection.connectionId));
    ensureExpanded(makeDockerComposeProjectTreeKey(connection.connectionId, project));
    onNavigate(
      {
        connectionId: connection.connectionId,
        category: "containers",
        composeProject: project,
      },
      mode,
    );
  };

  const renderContainerNode = (container: DockerContainerSummary, depth: number) => {
    const itemKey = makeDockerTreeKey(connection.connectionId, "containers", container.id);
    const containersRefreshKey = dockerSidebarCategoryRefreshKey(connection.connectionId, "containers");
    const openItem = (mode?: DockerConnectionDockOpenMode) => {
      ensureExpanded(makeDockerTreeKey(connection.connectionId));
      onNavigate(
        {
          connectionId: connection.connectionId,
          category: "containers",
          itemId: container.id,
        },
        mode,
      );
    };

    return (
      <SidebarTreeNode
        key={container.id}
        depth={depth}
        module="docker"
        nodeType="container"
        treeKey={itemKey}
        label={containerRowLabel(container)}
        icon={<DockerTreeIcon kind="container" />}
        className={dockerTreeNodeClassName("container")}
        hasChildren={false}
        expanded={false}
        active={activeNavKey === itemKey}
        dataAttrs={{ "data-docker-container-id": container.id }}
        shouldIgnoreClick={(target) =>
          Boolean((target as HTMLElement | null)?.closest(".tree-action-btn"))
        }
        onToggle={() => {}}
        onActivate={() => openItem("permanent")}
        trailing={
          <div className="tree-node-actions">
            <DockerTreeRefreshButton refreshKey={containersRefreshKey} onRefresh={onRefreshCategory} />
          </div>
        }
      />
    );
  };

  if (loading && containers.length === 0) {
    return <SidebarTreeEmpty>{t("docker.sidebar.treeLoading")}</SidebarTreeEmpty>;
  }
  if (error && containers.length === 0) {
    return <SidebarTreeEmpty>{error}</SidebarTreeEmpty>;
  }
  if (containers.length === 0) {
    return <SidebarTreeEmpty>{t("docker.sidebar.treeEmpty")}</SidebarTreeEmpty>;
  }
  if (
    hasSidebarTreeSearch(searchQuery) &&
    !connectionNameMatch &&
    visibleComposeProjects.length === 0 &&
    visibleStandaloneContainers.length === 0
  ) {
    return <SidebarTreeEmpty>{t("docker.sidebar.searchNoResults")}</SidebarTreeEmpty>;
  }

  return (
    <>
      {visibleComposeProjects.map((group) => {
        const projectKey = makeDockerComposeProjectTreeKey(connection.connectionId, group.project);
        const projectExpanded = isExpanded(projectKey);
        const containersRefreshKey = dockerSidebarCategoryRefreshKey(connection.connectionId, "containers");
        const projectContainers = filterComposeProjectContainers(group.containers);

        return (
          <div key={group.project} className="server-tree-category docker-compose-project-category">
            <SidebarTreeNode
              depth={1}
              module="docker"
              nodeType="compose-project"
              treeKey={projectKey}
              label={group.project}
              icon={<DockerTreeIcon kind="compose-project" />}
              className={dockerTreeNodeClassName("compose-project")}
              hasChildren
              expanded={projectExpanded}
              active={activeNavKey === projectKey}
              onToggle={() => toggle(projectKey)}
              onActivate={() => openComposeProject(group.project, "permanent")}
              shouldIgnoreClick={(target) =>
                Boolean((target as HTMLElement | null)?.closest(".tree-action-btn"))
              }
              trailing={
                <>
                  <span className="server-tree-badge">{projectContainers.length}</span>
                  <div className="tree-node-actions">
                    <DockerTreeRefreshButton refreshKey={containersRefreshKey} onRefresh={onRefreshCategory} />
                  </div>
                </>
              }
            />
            {projectExpanded ? (
              <div className="server-tree-children">
                <DockerSidebarExpandableLeaves
                  items={projectContainers}
                  getKey={(container) => container.id}
                  renderItem={(container) => renderContainerNode(container, 2)}
                />
              </div>
            ) : null}
          </div>
        );
      })}

      <DockerSidebarExpandableLeaves
        items={visibleStandaloneContainers}
        getKey={(container) => container.id}
        renderItem={(container) => renderContainerNode(container, 1)}
      />
    </>
  );
}
