import type { Locale } from "../stores/settingsStore";

/**
 * 启动同步 seed + 首屏必需（侧栏 / 路由 / Shell 全局文案）。
 * Shell 会直接用到 plugins / ai / userCenter / knowledge / dataSync / homeWorkspace，
 * 必须进 boot，否则首屏会闪 key。
 */
export const BOOT_LOCALE_KEYS = [
  "tags",
  "app",
  "common",
  "ui",
  "shell",
  "routes",
  "env",
  "resourceType",
  "notifications",
  "quickInput",
  "sidebarTree",
  "resourceTags",
  "resource",
  "share",
  "contentPreview",
  "stepUp",
  "skillPrompt",
  "logViewer",
  "settings",
  "workspace",
  "dashboard",
  "homeWorkspace",
  "plugins",
  "ai",
  "knowledge",
  "userCenter",
  "dataSync",
] as const;

/** 全部分片：切语言 / 启动时异步补齐，避免模块页显示 key */
export const ALL_LOCALE_CHUNK_KEYS = [
  ...BOOT_LOCALE_KEYS,
  "cloud",
  "moduleHost",
  "taskCenter",
  "files",
  "database",
  "terminal",
  "ssh",
  "docker",
  "server",
  "tasks",
  "protocol",
  "workflow",
  "syncTeamKeySetup",
  "syncDeviceAuth",
] as const;

export type LocaleChunkKey = string;

type ChunkLoader = () => Promise<{ default: unknown }>;

function zhLoader(name: string): ChunkLoader {
  // Vite 需要相对静态路径；按 name 映射
  const map: Record<string, ChunkLoader> = {
    tags: () => import("./locales/zh-CN/tags"),
    app: () => import("./locales/zh-CN/app"),
    knowledge: () => import("./locales/zh-CN/knowledge"),
    notifications: () => import("./locales/zh-CN/notifications"),
    logViewer: () => import("./locales/zh-CN/logViewer"),
    sidebarTree: () => import("./locales/zh-CN/sidebarTree"),
    resourceTags: () => import("./locales/zh-CN/resourceTags"),
    common: () => import("./locales/zh-CN/common"),
    skillPrompt: () => import("./locales/zh-CN/skillPrompt"),
    resource: () => import("./locales/zh-CN/resource"),
    quickInput: () => import("./locales/zh-CN/quickInput"),
    ui: () => import("./locales/zh-CN/ui"),
    share: () => import("./locales/zh-CN/share"),
    shell: () => import("./locales/zh-CN/shell"),
    routes: () => import("./locales/zh-CN/routes"),
    cloud: () => import("./locales/zh-CN/cloud"),
    moduleHost: () => import("./locales/zh-CN/moduleHost"),
    plugins: () => import("./locales/zh-CN/plugins"),
    taskCenter: () => import("./locales/zh-CN/taskCenter"),
    workspace: () => import("./locales/zh-CN/workspace"),
    env: () => import("./locales/zh-CN/env"),
    resourceType: () => import("./locales/zh-CN/resourceType"),
    contentPreview: () => import("./locales/zh-CN/contentPreview"),
    files: () => import("./locales/zh-CN/files"),
    database: () => import("./locales/zh-CN/database"),
    dashboard: () => import("./locales/zh-CN/dashboard"),
    homeWorkspace: () => import("./locales/zh-CN/homeWorkspace"),
    terminal: () => import("./locales/zh-CN/terminal"),
    ssh: () => import("./locales/zh-CN/ssh"),
    docker: () => import("./locales/zh-CN/docker"),
    server: () => import("./locales/zh-CN/server"),
    stepUp: () => import("./locales/zh-CN/stepUp"),
    settings: () => import("./locales/zh-CN/settings"),
    tasks: () => import("./locales/zh-CN/tasks"),
    protocol: () => import("./locales/zh-CN/protocol"),
    workflow: () => import("./locales/zh-CN/workflow"),
    ai: () => import("./locales/zh-CN/ai"),
    userCenter: () => import("./locales/zh-CN/userCenter"),
    syncTeamKeySetup: () => import("./locales/zh-CN/syncTeamKeySetup"),
    syncDeviceAuth: () => import("./locales/zh-CN/syncDeviceAuth"),
    dataSync: () => import("./locales/zh-CN/dataSync"),
  };
  const loader = map[name];
  if (!loader) throw new Error(`unknown zh chunk: ${name}`);
  return loader;
}

function enLoader(name: string): ChunkLoader {
  const map: Record<string, ChunkLoader> = {
    tags: () => import("./locales/en-US/tags"),
    app: () => import("./locales/en-US/app"),
    knowledge: () => import("./locales/en-US/knowledge"),
    notifications: () => import("./locales/en-US/notifications"),
    logViewer: () => import("./locales/en-US/logViewer"),
    sidebarTree: () => import("./locales/en-US/sidebarTree"),
    resourceTags: () => import("./locales/en-US/resourceTags"),
    common: () => import("./locales/en-US/common"),
    skillPrompt: () => import("./locales/en-US/skillPrompt"),
    resource: () => import("./locales/en-US/resource"),
    quickInput: () => import("./locales/en-US/quickInput"),
    ui: () => import("./locales/en-US/ui"),
    share: () => import("./locales/en-US/share"),
    shell: () => import("./locales/en-US/shell"),
    routes: () => import("./locales/en-US/routes"),
    cloud: () => import("./locales/en-US/cloud"),
    moduleHost: () => import("./locales/en-US/moduleHost"),
    plugins: () => import("./locales/en-US/plugins"),
    taskCenter: () => import("./locales/en-US/taskCenter"),
    workspace: () => import("./locales/en-US/workspace"),
    env: () => import("./locales/en-US/env"),
    resourceType: () => import("./locales/en-US/resourceType"),
    contentPreview: () => import("./locales/en-US/contentPreview"),
    files: () => import("./locales/en-US/files"),
    database: () => import("./locales/en-US/database"),
    dashboard: () => import("./locales/en-US/dashboard"),
    homeWorkspace: () => import("./locales/en-US/homeWorkspace"),
    terminal: () => import("./locales/en-US/terminal"),
    ssh: () => import("./locales/en-US/ssh"),
    docker: () => import("./locales/en-US/docker"),
    server: () => import("./locales/en-US/server"),
    stepUp: () => import("./locales/en-US/stepUp"),
    settings: () => import("./locales/en-US/settings"),
    tasks: () => import("./locales/en-US/tasks"),
    protocol: () => import("./locales/en-US/protocol"),
    workflow: () => import("./locales/en-US/workflow"),
    ai: () => import("./locales/en-US/ai"),
    userCenter: () => import("./locales/en-US/userCenter"),
    syncTeamKeySetup: () => import("./locales/en-US/syncTeamKeySetup"),
    syncDeviceAuth: () => import("./locales/en-US/syncDeviceAuth"),
    dataSync: () => import("./locales/en-US/dataSync"),
  };
  const loader = map[name];
  if (!loader) throw new Error(`unknown en chunk: ${name}`);
  return loader;
}

/** 模块路径 → 需要预热的 locale chunk（进入模块时优先拉取） */
export const MODULE_LOCALE_KEYS: Record<string, readonly string[]> = {
  database: ["database", "dataSync"],
  terminal: ["terminal"],
  ssh: ["ssh"],
  docker: ["docker"],
  server: ["server"],
  files: ["files"],
  protocol: ["protocol"],
  workflow: ["workflow"],
  knowledge: ["knowledge"],
  tasks: ["tasks", "taskCenter"],
  cloud: ["cloud"],
  plugins: ["plugins", "moduleHost"],
  settings: ["settings", "userCenter", "syncTeamKeySetup", "syncDeviceAuth"],
  dashboard: ["dashboard", "homeWorkspace", "workspace"],
  ai: ["ai"],
};

const loadedKeys = new Set<string>();
const bag: Record<Locale, Record<string, unknown>> = {
  "zh-CN": {},
  "en-US": {},
};

let localeRevision = 0;
const localeListeners = new Set<() => void>();

function keyId(locale: Locale, chunk: string) {
  return `${locale}:${chunk}`;
}

function bumpLocaleRevision() {
  localeRevision += 1;
  for (const listener of localeListeners) {
    listener();
  }
}

/** 供 useSyncExternalStore：文案分片加载完成后触发重渲 */
export function getLocaleRevision(): number {
  return localeRevision;
}

export function subscribeLocaleRevision(onStoreChange: () => void): () => void {
  localeListeners.add(onStoreChange);
  return () => {
    localeListeners.delete(onStoreChange);
  };
}

export function getLocaleBag(locale: Locale): Record<string, unknown> {
  return bag[locale];
}

/** 同步写入已加载的 chunk（启动 boot） */
export function seedLocaleChunks(
  locale: Locale,
  chunks: Record<string, unknown>,
): void {
  Object.assign(bag[locale], chunks);
  for (const name of Object.keys(chunks)) {
    loadedKeys.add(keyId(locale, name));
  }
  bumpLocaleRevision();
}

export async function ensureLocaleChunks(
  locale: Locale,
  chunks: readonly string[],
): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const chunk of chunks) {
    const id = keyId(locale, chunk);
    if (loadedKeys.has(id)) continue;
    const loader = locale === "zh-CN" ? zhLoader(chunk) : enLoader(chunk);
    pending.push(
      loader().then((mod) => {
        bag[locale][chunk] = mod.default;
        loadedKeys.add(id);
      }),
    );
  }
  if (pending.length === 0) return;
  await Promise.all(pending);
  bumpLocaleRevision();
}

/** 启动 / 切语言：加载全部分片，避免模块页残留 key */
export async function loadBootLocale(locale: Locale): Promise<void> {
  await ensureLocaleChunks(locale, ALL_LOCALE_CHUNK_KEYS);
}

export async function ensureModuleLocale(
  locale: Locale,
  moduleKey: string,
): Promise<void> {
  const chunks = MODULE_LOCALE_KEYS[moduleKey];
  if (!chunks) return;
  await ensureLocaleChunks(locale, chunks);
}

/** 测试重置 */
export function resetLocaleBagForTests(): void {
  loadedKeys.clear();
  bag["zh-CN"] = {};
  bag["en-US"] = {};
  localeRevision = 0;
}
