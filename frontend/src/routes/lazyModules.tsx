import { lazy, type ComponentType } from "react";

function lazyNamedModule<T extends ComponentType<object>>(
  loader: () => Promise<Record<string, T>>,
  exportName: string,
) {
  return lazy(async () => {
    const mod = await loader();
    const Component = mod[exportName];
    if (!Component) {
      throw new Error(`lazy module missing export: ${exportName}`);
    }
    return { default: Component };
  });
}

export const LazyTerminalPanel = lazyNamedModule(
  () => import("../modules/terminal/TerminalPanel"),
  "TerminalPanel",
);

export const LazyDatabasePanel = lazyNamedModule(
  () => import("../modules/database/DatabasePanel"),
  "DatabasePanel",
);

export const LazyDockerPanel = lazyNamedModule(
  () => import("../modules/docker/DockerPanel"),
  "DockerPanel",
);

export const LazySshPanel = lazyNamedModule(
  () => import("../modules/server/SshPanel"),
  "SshPanel",
);

export const LazyServerPanel = lazyNamedModule(
  () => import("../modules/server/ServerPanel"),
  "ServerPanel",
);

export const LazyProtocolPanel = lazyNamedModule(
  () => import("../modules/protocol/ProtocolPanel"),
  "ProtocolPanel",
);

export const LazyWorkflowPanel = lazyNamedModule(
  () => import("../modules/workflow/WorkflowPanel"),
  "WorkflowPanel",
);

export const LazyKnowledgePanel = lazyNamedModule(
  () => import("../modules/knowledge/KnowledgePanel"),
  "KnowledgePanel",
);

export const LazyFilesPanel = lazyNamedModule(
  () => import("../modules/files/FilesPanel"),
  "FilesPanel",
);

export const LazyTaskCenterPanel = lazyNamedModule(
  () => import("../modules/tasks/TaskCenterPanel"),
  "TaskCenterPanel",
);

export const LazyCloudPanel = lazyNamedModule(
  () => import("../modules/cloud/CloudPanel"),
  "CloudPanel",
);

export const LazyDashboardPage = lazyNamedModule(
  () => import("../modules/workspace/DashboardPage"),
  "DashboardPage",
);

export const LazyUserWorkspace = lazyNamedModule(
  () => import("../modules/workspace/UserWorkspace"),
  "UserWorkspace",
);

export const LazyPluginsPanel = lazyNamedModule(
  () => import("../modules/plugins/PluginsPanel"),
  "PluginsPanel",
);

const EXTRA_IDLE_LOADERS = [
  () => import("../modules/workspace/DashboardPage"),
  () => import("../modules/workspace/UserWorkspace"),
] as const;

/** 空闲时只补 Dashboard / UserWorkspace 两个非叠层 chunk。叠层由 scheduleIdleChunkWarm 覆盖。 */
export function preloadModuleChunks(): void {
  let index = 0;
  const loadNext = () => {
    if (index >= EXTRA_IDLE_LOADERS.length) return;
    const loader = EXTRA_IDLE_LOADERS[index++];
    void loader()
      .catch(() => {})
      .finally(() => {
        if (typeof requestIdleCallback === "function") {
          requestIdleCallback(loadNext, { timeout: 2000 });
        } else {
          window.setTimeout(loadNext, 50);
        }
      });
  };
  loadNext();
}
