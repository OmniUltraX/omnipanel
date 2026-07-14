import { commands } from "../../ipc/bindings";
import type {
  DockerComposeProject,
  DockerComposeProjectFiles,
  DockerComposeReadFilesRequest,
  DockerComposeRequest,
  DockerComposeResult,
  DockerComposeWriteFilesRequest,
} from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { debugCompose } from "./dockerComposeDebug";

const unwrap = unwrapCommand;

type ComposeMetaCacheEntry = {
  meta: DockerComposeProject;
  fetchedAt: number;
};

type ComposeProjectsListCacheEntry = {
  projects: DockerComposeProject[];
  fetchedAt: number;
};

const composeMetaCache = new Map<string, ComposeMetaCacheEntry>();
/** 连接级项目列表缓存：避免每个 Compose Tab 都再跑一次全量 list */
const composeProjectsListCache = new Map<string, ComposeProjectsListCacheEntry>();
const COMPOSE_META_TTL_MS = 60_000;

function composeMetaCacheKey(connectionId: string, project: string): string {
  return `${connectionId}::${project.trim()}`;
}

function warmComposeMetaCache(connectionId: string, projects: DockerComposeProject[]): void {
  const now = Date.now();
  for (const meta of projects) {
    composeMetaCache.set(composeMetaCacheKey(connectionId, meta.name), {
      meta,
      fetchedAt: now,
    });
  }
}

export function peekComposeProjectMeta(
  connectionId: string,
  projectName: string,
): DockerComposeProject | undefined {
  const cached = composeMetaCache.get(composeMetaCacheKey(connectionId, projectName));
  if (!cached) return undefined;
  if (Date.now() - cached.fetchedAt > COMPOSE_META_TTL_MS) return undefined;
  return cached.meta;
}

export async function getComposeProjectMeta(
  connectionId: string,
  projectName: string,
): Promise<DockerComposeProject | undefined> {
  const key = composeMetaCacheKey(connectionId, projectName);
  const cached = composeMetaCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < COMPOSE_META_TTL_MS) {
    debugCompose("getComposeProjectMeta 命中缓存", { project: projectName });
    return cached.meta;
  }
  const projects = await fetchComposeProjects(connectionId);
  return findComposeProjectMeta(projects, projectName);
}

export function invalidateComposeProjectMeta(connectionId: string, projectName?: string): void {
  if (projectName) {
    composeMetaCache.delete(composeMetaCacheKey(connectionId, projectName));
    return;
  }
  composeProjectsListCache.delete(connectionId);
  for (const key of composeMetaCache.keys()) {
    if (key.startsWith(`${connectionId}::`)) {
      composeMetaCache.delete(key);
    }
  }
}

/**
 * 列出连接上全部 Compose 项目（SSH 上等于扫一遍容器 labels，较慢）。
 * 结果按连接缓存，并预热每个 project 的 meta，避免打开下一个项目再拉全量。
 */
export async function fetchComposeProjects(connectionId: string): Promise<DockerComposeProject[]> {
  const cached = composeProjectsListCache.get(connectionId);
  if (cached && Date.now() - cached.fetchedAt < COMPOSE_META_TTL_MS) {
    debugCompose("fetchComposeProjects 命中连接级缓存", {
      connectionId,
      count: cached.projects.length,
    });
    return cached.projects;
  }
  debugCompose("fetchComposeProjects 请求全量列表", { connectionId });
  const started = performance.now();
  const projects = await unwrap(commands.dockerListComposeProjects(connectionId));
  debugCompose("fetchComposeProjects 完成", {
    connectionId,
    count: projects.length,
    ms: Math.round(performance.now() - started),
  });
  composeProjectsListCache.set(connectionId, { projects, fetchedAt: Date.now() });
  warmComposeMetaCache(connectionId, projects);
  return projects;
}

export async function readComposeProjectFiles(
  connectionId: string,
  request: DockerComposeReadFilesRequest,
): Promise<DockerComposeProjectFiles> {
  debugCompose("readComposeProjectFiles 请求", {
    connectionId,
    project: request.project,
    workingDir: request.workingDir,
    configFile: request.configFile,
  });
  try {
    const files = await unwrap(commands.dockerReadComposeFiles(connectionId, request));
    debugCompose("readComposeProjectFiles 响应", {
      composePath: files.composePath,
      envPath: files.envPath,
      composeBytes: files.composeContent.length,
      envBytes: files.envContent.length,
      composePreview: files.composeContent.slice(0, 120),
      envPreview: files.envContent.slice(0, 120),
    });
    return files;
  } catch (error) {
    debugCompose("readComposeProjectFiles 失败", {
      connectionId,
      project: request.project,
      error: String(error),
    });
    throw error;
  }
}

export async function writeComposeProjectFiles(
  connectionId: string,
  request: DockerComposeWriteFilesRequest,
): Promise<void> {
  await unwrap(commands.dockerWriteComposeFiles(connectionId, request));
}

export async function runComposeAction(
  connectionId: string,
  action: "up" | "down" | "restart" | "rebuild" | "pull" | "logs",
  request: DockerComposeRequest,
): Promise<DockerComposeResult> {
  return unwrap(commands.dockerComposeAction(connectionId, action, request));
}

export function findComposeProjectMeta(
  projects: DockerComposeProject[],
  projectName: string,
): DockerComposeProject | undefined {
  const needle = projectName.trim();
  return projects.find((item) => item.name === needle);
}
