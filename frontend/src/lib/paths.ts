export const MODULE_PREFIX = "/module";
export const WORKSPACE_PREFIX = "/workspace";
export const DASHBOARD_PATH = "/dashboard";
export const PLUGINS_PATH = "/plugins";

export const MODULE_PATHS = {
  terminal: `${MODULE_PREFIX}/terminal`,
  ssh: `${MODULE_PREFIX}/ssh`,
  database: `${MODULE_PREFIX}/database`,
  docker: `${MODULE_PREFIX}/docker`,
  server: `${MODULE_PREFIX}/server`,
  files: `${MODULE_PREFIX}/files`,
  cloud: `${MODULE_PREFIX}/cloud`,
  protocol: `${MODULE_PREFIX}/protocol`,
  workflow: `${MODULE_PREFIX}/workflow`,
  knowledge: `${MODULE_PREFIX}/knowledge`,
  tasks: `${MODULE_PREFIX}/tasks`,
} as const;

export type ModuleKey = keyof typeof MODULE_PATHS;

export const ALL_MODULE_KEYS = Object.keys(MODULE_PATHS) as ModuleKey[];

export function isKernelModuleKey(key: string): key is ModuleKey {
  return key in MODULE_PATHS;
}

export function moduleKeyFromPath(path: string): ModuleKey | null {
  for (const [key, modulePath] of Object.entries(MODULE_PATHS) as [ModuleKey, string][]) {
    if (path === modulePath || path.startsWith(`${modulePath}/`)) {
      return key;
    }
  }
  return null;
}

/** `/module/{key}` 中非内核模块的 key（如 nacos）。 */
export function pluginModuleKeyFromPath(pathname: string): string | null {
  if (!pathname.startsWith(`${MODULE_PREFIX}/`)) return null;
  const key = pathname.slice(MODULE_PREFIX.length + 1).split("/")[0] ?? "";
  if (!key || isKernelModuleKey(key)) return null;
  return key;
}

export function navModuleKeyFromPath(pathname: string): string | null {
  return moduleKeyFromPath(pathname) ?? pluginModuleKeyFromPath(pathname);
}

export const WORKSPACE_PATHS = {
  list: WORKSPACE_PREFIX,
  detail: (id: string) => `${WORKSPACE_PREFIX}/${id}`,
  default: `${WORKSPACE_PREFIX}/default`,
} as const;

export function isDashboardPath(pathname: string): boolean {
  return pathname === DASHBOARD_PATH;
}

export function isPluginsPath(pathname: string): boolean {
  return pathname === PLUGINS_PATH || pathname.startsWith(`${PLUGINS_PATH}/`);
}

export function modulePathForType(type: string): string {
  if (type === "file") return MODULE_PATHS.files;
  const entry = (MODULE_PATHS as Record<string, string>)[type];
  return entry ?? `${MODULE_PREFIX}/${type}`;
}

export function isModulePath(pathname: string): boolean {
  return pathname.startsWith(MODULE_PREFIX);
}

export function isWorkspacePath(pathname: string): boolean {
  return pathname === WORKSPACE_PREFIX || pathname.startsWith(`${WORKSPACE_PREFIX}/`);
}
