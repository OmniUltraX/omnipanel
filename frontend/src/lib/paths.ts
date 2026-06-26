export const MODULE_PREFIX = "/module";
export const WORKSPACE_PREFIX = "/workspace";
export const DASHBOARD_PATH = "/dashboard";

export const MODULE_PATHS = {
  terminal: `${MODULE_PREFIX}/terminal`,
  database: `${MODULE_PREFIX}/database`,
  docker: `${MODULE_PREFIX}/docker`,
  ssh: `${MODULE_PREFIX}/ssh`,
  server: `${MODULE_PREFIX}/server`,
  protocol: `${MODULE_PREFIX}/protocol`,
  workflow: `${MODULE_PREFIX}/workflow`,
  knowledge: `${MODULE_PREFIX}/knowledge`,
  files: `${MODULE_PREFIX}/files`,
} as const;

export type ModuleKey = keyof typeof MODULE_PATHS;

/** 暂不在导航中展示的模块（路由保留，便于直接 URL 或后续启用） */
export const HIDDEN_MODULE_NAV_KEYS: readonly ModuleKey[] = ["workflow"];

const HIDDEN_MODULE_NAV_KEY_SET = new Set<ModuleKey>(HIDDEN_MODULE_NAV_KEYS);

export function isModuleNavVisible(moduleKey: ModuleKey): boolean {
  return !HIDDEN_MODULE_NAV_KEY_SET.has(moduleKey);
}

export function isModulePathNavVisible(path: string): boolean {
  for (const [key, modulePath] of Object.entries(MODULE_PATHS) as [ModuleKey, string][]) {
    if (path === modulePath) {
      return isModuleNavVisible(key);
    }
  }
  return true;
}

export const NAV_VISIBLE_MODULE_KEYS = (Object.keys(MODULE_PATHS) as ModuleKey[]).filter(
  isModuleNavVisible,
);

export const WORKSPACE_PATHS = {
  list: WORKSPACE_PREFIX,
  detail: (id: string) => `${WORKSPACE_PREFIX}/${id}`,
  default: `${WORKSPACE_PREFIX}/default`,
} as const;

export function isDashboardPath(pathname: string): boolean {
  return pathname === DASHBOARD_PATH;
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
