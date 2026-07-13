import { commands } from "../../ipc/bindings";
import type {
  DockerComposeProject,
  DockerComposeProjectFiles,
  DockerComposeReadFilesRequest,
  DockerComposeRequest,
  DockerComposeResult,
  DockerComposeWriteFilesRequest,
} from "../../ipc/bindings";
import { debugCompose } from "./dockerComposeDebug";

async function unwrap<T>(
  promise: Promise<{ status: "ok"; data: T } | { status: "error"; error: { message: string } }>,
): Promise<T> {
  const res = await promise;
  if (res.status === "ok") return res.data;
  throw new Error(res.error.message);
}

type ComposeMetaCacheEntry = {
  meta: DockerComposeProject;
  fetchedAt: number;
};

const composeMetaCache = new Map<string, ComposeMetaCacheEntry>();
const COMPOSE_META_TTL_MS = 60_000;

function composeMetaCacheKey(connectionId: string, project: string): string {
  return `${connectionId}::${project.trim()}`;
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
  const meta = findComposeProjectMeta(projects, projectName);
  if (meta) {
    composeMetaCache.set(key, { meta, fetchedAt: Date.now() });
  }
  return meta;
}

export function invalidateComposeProjectMeta(connectionId: string, projectName?: string): void {
  if (projectName) {
    composeMetaCache.delete(composeMetaCacheKey(connectionId, projectName));
    return;
  }
  for (const key of composeMetaCache.keys()) {
    if (key.startsWith(`${connectionId}::`)) {
      composeMetaCache.delete(key);
    }
  }
}

export async function fetchComposeProjects(connectionId: string): Promise<DockerComposeProject[]> {
  return unwrap(commands.dockerListComposeProjects(connectionId));
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
