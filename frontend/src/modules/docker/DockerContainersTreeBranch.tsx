import { useCallback, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useI18n } from "@/i18n";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/ContextMenu";
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
import {
  confirmAndDownComposeProject,
  confirmAndRemoveDockerContainer,
} from "./dockerTreeDestructiveActions";

type DockerContainersTreeBranchProps = {
  connection: DockerConnectionInfo;
  containers: DockerContainerSummary[];
  activeNavKey: string | null;
  searchQuery: string;
  connectionNameMatch: boolean;
  loading: boolean;
  isExpanded: (key: string) => boolean;
  toggle: (key: string) => void;
  ensureExpanded: (key: string) => void;
  onNavigate: DockerSidebarNavigate;
  onRefreshCategory: () => void;
};

type TreeContextTarget =
  | { kind: "compose"; project: string }
  | { kind: "container"; container: DockerContainerSummary };

export function DockerContainersTreeBranch({
  connection,
  containers,
  activeNavKey,
  searchQuery,
  connectionNameMatch,
  loading,
  isExpanded,
  toggle,
  ensureExpanded,
  onNavigate,
  onRefreshCategory,
}: DockerContainersTreeBranchProps) {
  const { t } = useI18n();
  const [ctxPos, setCtxPos] = useState<{ x: number; y: number } | null>(null);
  const [ctxTarget, setCtxTarget] = useState<TreeContextTarget | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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

  const openContextMenu = useCallback((event: ReactMouseEvent, target: TreeContextTarget) => {
    event.preventDefault();
    event.stopPropagation();
    setActionError(null);
    setCtxPos({ x: event.clientX, y: event.clientY });
    setCtxTarget(target);
  }, []);

  const closeContextMenu = useCallback(() => {
    setCtxPos(null);
    setCtxTarget(null);
  }, []);

  const ctxItems = useMemo<ContextMenuItem[]>(() => {
    if (!ctxTarget) return [];
    if (ctxTarget.kind === "compose") {
      const project = ctxTarget.project;
      return [
        {
          id: "compose-down",
          label: t("docker.composePanel.down"),
          danger: true,
          onClick: () => {
            void (async () => {
              try {
                await confirmAndDownComposeProject({
                  connectionId: connection.connectionId,
                  project,
                  t,
                });
              } catch (error) {
                setActionError(String(error));
              }
            })();
          },
        },
      ];
    }
    const container = ctxTarget.container;
    const name = container.name || container.shortId || container.id.slice(0, 12);
    return [
      {
        id: "container-remove",
        label: t("docker.dockPanel.removeContainer"),
        danger: true,
        onClick: () => {
          void (async () => {
            try {
              await confirmAndRemoveDockerContainer({
                connectionId: connection.connectionId,
                containerId: container.id,
                containerName: name,
                t,
              });
            } catch (error) {
              setActionError(String(error));
            }
          })();
        },
      },
    ];
  }, [connection.connectionId, ctxTarget, t]);

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
        onSelect={() => openItem("preview")}
        onActivate={() => openItem("permanent")}
        onContextMenu={(event) => openContextMenu(event, { kind: "container", container })}
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
  // 无法连接时不展示具体错误文案，与无数据同一空态
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
      {actionError ? (
        <div className="form-hint" role="alert" style={{ color: "var(--danger, #ef4444)", marginBottom: 8 }}>
          {actionError}
        </div>
      ) : null}
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
              onSelect={() => openComposeProject(group.project, "preview")}
              onActivate={() => openComposeProject(group.project, "permanent")}
              onContextMenu={(event) =>
                openContextMenu(event, { kind: "compose", project: group.project })
              }
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

      {ctxPos ? (
        <ContextMenu items={ctxItems} position={ctxPos} onClose={closeContextMenu} />
      ) : null}
    </>
  );
}
