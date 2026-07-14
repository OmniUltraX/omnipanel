import type { DockerComposeProject } from "../../ipc/bindings";

/** Compose 面板快照（关闭后重开时回填，内存常驻至进程结束）。 */
export type DockerComposePanelCacheEntry = {
  workingDir: string | null;
  configFile: string | null;
  composePath: string;
  envPath: string;
  composeContent: string;
  envContent: string;
  savedComposeContent: string;
  savedEnvContent: string;
  filesReadOnly: boolean;
  metaReady: boolean;
  logsText: string;
  /** serviceKey → 是否纳入编排日志；缺省键视为 true（默认全开） */
  logEnabledByService: Record<string, boolean>;
  updatedAt: number;
};

const panelCache = new Map<string, DockerComposePanelCacheEntry>();

export function composePanelCacheKey(connectionId: string, project: string): string {
  return `${connectionId}::${project.trim()}`;
}

/** 编排日志过滤键：优先 Compose service，其次容器名。 */
export function composeLogServiceKey(container: {
  id: string;
  name: string;
  composeService?: string | null;
}): string {
  const service = container.composeService?.trim();
  if (service) return service;
  const name = container.name.trim().replace(/^\//, "");
  if (name) return name;
  return container.id;
}

export function peekComposePanelCache(
  connectionId: string,
  project: string,
): DockerComposePanelCacheEntry | undefined {
  return panelCache.get(composePanelCacheKey(connectionId, project));
}

export function writeComposePanelCache(
  connectionId: string,
  project: string,
  entry: Omit<DockerComposePanelCacheEntry, "updatedAt">,
): void {
  panelCache.set(composePanelCacheKey(connectionId, project), {
    ...entry,
    updatedAt: Date.now(),
  });
}

export function clearComposePanelCache(connectionId: string, project?: string): void {
  if (project) {
    panelCache.delete(composePanelCacheKey(connectionId, project));
    return;
  }
  const prefix = `${connectionId}::`;
  for (const key of panelCache.keys()) {
    if (key.startsWith(prefix)) panelCache.delete(key);
  }
}

const EMPTY_LOG_SERVICES: string[] = [];

/** 根据开关得到 compose logs 的 services 参数：全开 → []；部分开 → 开启的 service 名；全关 → null（跳过拉取）。 */
export function resolveComposeLogServices(
  serviceKeys: string[],
  logEnabledByService: Record<string, boolean>,
): string[] | null {
  if (serviceKeys.length === 0) return EMPTY_LOG_SERVICES;
  const enabled = serviceKeys.filter((key) => logEnabledByService[key] !== false);
  if (enabled.length === 0) return null;
  if (enabled.length === serviceKeys.length) return EMPTY_LOG_SERVICES;
  return enabled;
}

export function isComposeLogServiceEnabled(
  serviceKey: string,
  logEnabledByService: Record<string, boolean>,
): boolean {
  return logEnabledByService[serviceKey] !== false;
}

/** 用侧栏 meta 补全缓存缺省字段（无面板快照时）。 */
export function seedComposePanelFromMeta(
  meta: DockerComposeProject | undefined,
): Pick<DockerComposePanelCacheEntry, "workingDir" | "configFile" | "metaReady"> {
  const workingDir = meta?.workingDir ?? null;
  const configFile = meta?.configFiles?.split(",")[0]?.trim() || null;
  return {
    workingDir,
    configFile,
    metaReady: Boolean(workingDir),
  };
}
