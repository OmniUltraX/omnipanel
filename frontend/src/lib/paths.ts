export const MODULE_PREFIX = "/module";
export const WORKSPACE_PREFIX = "/workspace";

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

export const WORKSPACE_PATHS = {
  list: WORKSPACE_PREFIX,
  dashboard: (id: string) => `${WORKSPACE_PREFIX}/${id}`,
  default: `${WORKSPACE_PREFIX}/default`,
} as const;

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
