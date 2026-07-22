import { lazy, type ComponentType } from "react";
import type { OverlayModuleKey } from "../lib/routePanels";
import { preloadOverlayModuleChunk } from "../lib/moduleWarmup";

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

export const LazyDashboardPage = lazyNamedModule(
  () => import("../modules/workspace/DashboardPage"),
  "DashboardPage",
);

export const LazyUserWorkspace = lazyNamedModule(
  () => import("../modules/workspace/UserWorkspace"),
  "UserWorkspace",
);

/** 空闲预热顺序：终端优先，其余随后；仅拉 chunk，不挂载 */
const IDLE_CHUNK_KEYS: OverlayModuleKey[] = [
  "terminal",
  "database",
  "docker",
  "server",
  "files",
  "protocol",
  "workflow",
  "knowledge",
  "tasks",
];

const EXTRA_IDLE_LOADERS = [
  () => import("../modules/workspace/DashboardPage"),
  () => import("../modules/workspace/UserWorkspace"),
] as const;

/** 空闲时逐个预拉取模块 chunk，首次点击侧栏即可秒开；避免一次打满主线程 */
export function preloadModuleChunks(): void {
  let index = 0;
  const loadNext = () => {
    if (index < IDLE_CHUNK_KEYS.length) {
      const key = IDLE_CHUNK_KEYS[index++];
      void preloadOverlayModuleChunk(key).finally(() => {
        if (typeof requestIdleCallback === "function") {
          requestIdleCallback(loadNext, { timeout: 2000 });
        } else {
          window.setTimeout(loadNext, 50);
        }
      });
      return;
    }
    const extraIndex = index - IDLE_CHUNK_KEYS.length;
    if (extraIndex >= EXTRA_IDLE_LOADERS.length) return;
    index++;
    void EXTRA_IDLE_LOADERS[extraIndex]()
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
