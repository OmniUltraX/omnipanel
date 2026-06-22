import { lazy, type ComponentType } from "react";

function lazyNamedModule<T extends ComponentType<object>>(
  loader: () => Promise<Record<string, T>>,
  exportName: string,
  styleImport?: () => Promise<unknown>,
) {
  return lazy(async () => {
    if (styleImport) {
      await styleImport();
    }
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
  () => import("../styles/modules/terminal.css"),
);

export const LazyDatabasePanel = lazyNamedModule(
  () => import("../modules/database/DatabasePanel"),
  "DatabasePanel",
  () => import("../styles/modules/database.css"),
);

export const LazyDockerPanel = lazyNamedModule(
  () => import("../modules/docker/DockerPanel"),
  "DockerPanel",
  () => import("../styles/modules/docker.css"),
);

export const LazySshPanel = lazyNamedModule(
  () => import("../modules/server/SshPanel"),
  "SshPanel",
  () => import("../styles/modules/server.css"),
);

export const LazyServerPanel = lazyNamedModule(
  () => import("../modules/server/ServerPanel"),
  "ServerPanel",
  () => import("../styles/modules/server.css"),
);

export const LazyProtocolPanel = lazyNamedModule(
  () => import("../modules/protocol/ProtocolPanel"),
  "ProtocolPanel",
  () => import("../styles/modules/protocol.css"),
);

export const LazyWorkflowPanel = lazyNamedModule(
  () => import("../modules/workflow/WorkflowPanel"),
  "WorkflowPanel",
  () => import("../styles/modules/workflow.css"),
);

export const LazyKnowledgePanel = lazyNamedModule(
  () => import("../modules/knowledge/KnowledgePanel"),
  "KnowledgePanel",
  () => import("../styles/modules/knowledge.css"),
);

export const LazyFilesPanel = lazyNamedModule(
  () => import("../modules/files/FilesPanel"),
  "FilesPanel",
  () => import("../styles/modules/files.css"),
);

export const LazyDashboardPage = lazyNamedModule(
  () => import("../modules/workspace/DashboardPage"),
  "DashboardPage",
);

export const LazyUserWorkspace = lazyNamedModule(
  () => import("../modules/workspace/UserWorkspace"),
  "UserWorkspace",
);
