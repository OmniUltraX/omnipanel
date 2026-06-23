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

export const LazyDashboardPage = lazyNamedModule(
  () => import("../modules/workspace/DashboardPage"),
  "DashboardPage",
);

export const LazyUserWorkspace = lazyNamedModule(
  () => import("../modules/workspace/UserWorkspace"),
  "UserWorkspace",
);
