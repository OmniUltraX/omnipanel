import { MODULE_PATHS, DASHBOARD_PATH } from "../../lib/paths";
import type { OverlayModuleKey } from "../../lib/routePanels";
import { preloadOverlayModuleChunk } from "../../lib/moduleWarmup";
import { createTerminalSessionService } from "../terminal/terminalSessionService";
import { createSshSessionService } from "../server/ssh/sshSessionService";
import { createDockerSessionService } from "../docker/dockerSessionService";
import { createDatabaseSessionService } from "../database/databaseSessionService";
import { registerModule } from "./registry";
import { ensureSessionService } from "./sessionServices";
import type { ModuleDescriptor } from "./types";

let builtinsRegistered = false;

type OverlayBuiltinSpec = {
  id: OverlayModuleKey;
  path: string;
  pinWhen?: "workspace-mirror";
  loadView: ModuleDescriptor["loadView"];
  createSessionService?: ModuleDescriptor["createSessionService"];
};

const OVERLAY_BUILTINS: OverlayBuiltinSpec[] = [
  {
    id: "terminal",
    path: MODULE_PATHS.terminal,
    pinWhen: "workspace-mirror",
    loadView: () =>
      import("../terminal/TerminalPanel").then((m) => ({ default: m.TerminalPanel })),
    createSessionService: () => createTerminalSessionService(),
  },
  {
    id: "ssh",
    path: MODULE_PATHS.ssh,
    loadView: () =>
      import("../server/SshPanel").then((m) => ({ default: m.SshPanel })),
    createSessionService: () => createSshSessionService(),
  },
  {
    id: "docker",
    path: MODULE_PATHS.docker,
    loadView: () =>
      import("../docker/DockerPanel").then((m) => ({ default: m.DockerPanel })),
    createSessionService: () => createDockerSessionService(),
  },
  {
    id: "database",
    path: MODULE_PATHS.database,
    pinWhen: "workspace-mirror",
    loadView: () =>
      import("../database/DatabasePanel").then((m) => ({
        default: m.DatabasePanel,
      })),
    createSessionService: () => createDatabaseSessionService(),
  },
  {
    id: "files",
    path: MODULE_PATHS.files,
    loadView: () =>
      import("../files/FilesPanel").then((m) => ({ default: m.FilesPanel })),
  },
  {
    id: "server",
    path: MODULE_PATHS.server,
    loadView: () =>
      import("../server/ServerPanel").then((m) => ({ default: m.ServerPanel })),
  },
  {
    id: "protocol",
    path: MODULE_PATHS.protocol,
    loadView: () =>
      import("../protocol/ProtocolPanel").then((m) => ({
        default: m.ProtocolPanel,
      })),
  },
  {
    id: "workflow",
    path: MODULE_PATHS.workflow,
    loadView: () =>
      import("../workflow/WorkflowPanel").then((m) => ({
        default: m.WorkflowPanel,
      })),
  },
  {
    id: "knowledge",
    path: MODULE_PATHS.knowledge,
    loadView: () =>
      import("../knowledge/KnowledgePanel").then((m) => ({
        default: m.KnowledgePanel,
      })),
  },
  {
    id: "tasks",
    path: MODULE_PATHS.tasks,
    loadView: () =>
      import("../tasks/TaskCenterPanel").then((m) => ({
        default: m.TaskCenterPanel,
      })),
  },
  {
    id: "cloud",
    path: MODULE_PATHS.cloud,
    loadView: () =>
      import("../cloud/CloudPanel").then((m) => ({ default: m.CloudPanel })),
  },
];

function dashboardDescriptor(): ModuleDescriptor {
  return {
    id: "dashboard",
    path: DASHBOARD_PATH,
    keepLayout: true,
    alwaysMounted: true,
    keepAlive: { recentEligible: false },
    loadView: () =>
      import("../workspace/DashboardPage").then((m) => ({
        default: m.DashboardPage,
      })),
    warmChunk: () => import("../workspace/DashboardPage"),
  };
}

function overlayDescriptor(spec: OverlayBuiltinSpec): ModuleDescriptor {
  return {
    id: spec.id,
    path: spec.path,
    keepLayout: true,
    keepAlive: {
      recentEligible: true,
      pinWhen: spec.pinWhen,
    },
    loadView: spec.loadView,
    warmChunk: () => preloadOverlayModuleChunk(spec.id),
    createSessionService: spec.createSessionService,
  };
}

/** 幂等注册内建模块；App / ModuleHost 启动时调用 */
export function ensureBuiltinModulesRegistered(): void {
  if (builtinsRegistered) return;
  registerModule(dashboardDescriptor());
  for (const spec of OVERLAY_BUILTINS) {
    registerModule(overlayDescriptor(spec));
  }
  builtinsRegistered = true;
  // Session 与 View 解耦：启动即创建，踢出模块时 onModuleEvicted 不 dispose
  ensureSessionService("terminal");
  ensureSessionService("ssh");
  ensureSessionService("docker");
  ensureSessionService("database");
}

/** 单测重置 builtins 标志（需配合 clearModuleRegistryForTests） */
export function resetBuiltinModulesRegistrationForTests(): void {
  builtinsRegistered = false;
}
