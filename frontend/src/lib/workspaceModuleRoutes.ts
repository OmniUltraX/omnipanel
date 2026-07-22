import type { ModuleKey } from "./paths";
import { MODULE_PATHS } from "./paths";

/** 可加入工作区的模块路由快照 */
export type ModuleRouteSnapshot = {
  module: "route";
  id: string;
  label: string;
  path: string;
  moduleKey: ModuleKey;
  /** 模块内分段 tab（如 ssh:hosts） */
  segmentTabId?: string;
};

const MODULE_NAV_KEYS: Record<ModuleKey, string> = {
  terminal: "shell.nav.terminal",
  database: "shell.nav.database",
  docker: "shell.nav.docker",
  ssh: "shell.nav.ssh",
  server: "shell.nav.server",
  files: "shell.nav.files",
  protocol: "shell.nav.protocol",
  workflow: "shell.nav.workflow",
  knowledge: "shell.nav.knowledge",
  tasks: "shell.nav.tasks",
};

export function moduleKeyFromPath(pathname: string): ModuleKey | null {
  for (const [key, modulePath] of Object.entries(MODULE_PATHS) as [ModuleKey, string][]) {
    if (pathname === modulePath || pathname.startsWith(`${modulePath}/`)) {
      return key;
    }
  }
  return null;
}

/** AI 助手上下文选择器的 value（module:xxx / workspace:xxx） */
export function aiContextValueFromPath(
  pathname: string,
  workspaceIds?: readonly string[],
): string {
  const moduleKey = moduleKeyFromPath(pathname);
  if (moduleKey) {
    return `module:${moduleKey}`;
  }

  const workspaceMatch = pathname.match(/^\/workspace\/([^/]+)/);
  if (workspaceMatch) {
    const id = decodeURIComponent(workspaceMatch[1]);
    if (!workspaceIds || workspaceIds.includes(id)) {
      return `workspace:${id}`;
    }
  }

  return "";
}

export function moduleNavI18nKey(moduleKey: ModuleKey): string {
  return MODULE_NAV_KEYS[moduleKey];
}

export function buildModuleRouteSnapshot(
  moduleKey: ModuleKey,
  label: string,
  options?: { segmentTabId?: string },
): ModuleRouteSnapshot {
  const path = MODULE_PATHS[moduleKey];
  const segment = options?.segmentTabId;
  const id = segment
    ? `route:${moduleKey}:${segment}`
    : `route:${moduleKey}`;
  return {
    module: "route",
    id,
    label,
    path,
    moduleKey,
    segmentTabId: segment,
  };
}

export function isModuleRouteSnapshot(
  snapshot: { module: string },
): snapshot is ModuleRouteSnapshot {
  return snapshot.module === "route";
}
