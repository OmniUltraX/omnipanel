import { commands } from "../../ipc/bindings";
import type {
  DockerComposeProject,
  DockerComposeProjectFiles,
  DockerComposeReadFilesRequest,
  DockerComposeRequest,
  DockerComposeResult,
  DockerComposeWriteFilesRequest,
  DockerContainerSummary,
} from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { DOCKER_QUIET_IPC, handleDockerAutoFetchFailure } from "./dockerConnectionOffline";
import { beginComposeDebug, debugCompose } from "./dockerComposeDebug";
import { runWithDockerBoundSsh } from "./ensureDockerBoundSsh";
import {
  invalidateComposeFilesCache,
  isComposeFilesCacheFresh,
  peekComposeFilesCache,
  writeComposeFilesCache,
} from "./dockerComposeFilesCache";

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
/** 同 key 并发合并，避免 Strict Mode / 面板双激活用两次 IPC */
const fetchComposeProjectsInflight = new Map<string, Promise<DockerComposeProject[]>>();
const readComposeFilesInflight = new Map<string, Promise<DockerComposeProjectFiles>>();
const COMPOSE_META_TTL_MS = 60_000;

export {
  peekComposeFilesCache,
  isComposeFilesCacheFresh,
  COMPOSE_FILES_FRESH_TTL_MS,
} from "./dockerComposeFilesCache";
export type { ComposeFilesCacheEntry } from "./dockerComposeFilesCache";

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

/**
 * 用侧栏已加载的容器 labels 预热 compose meta。
 * 打开 Compose 面板时可跳过昂贵的 `dockerListComposeProjects`。
 */
export function warmComposeMetaFromContainers(
  connectionId: string,
  containers: ReadonlyArray<
    Pick<DockerContainerSummary, "composeProject" | "composeWorkingDir" | "composeConfigFiles">
  >,
): number {
  const byName = new Map<string, DockerComposeProject>();
  for (const container of containers) {
    const name = container.composeProject?.trim();
    if (!name) continue;
    const workingDir = container.composeWorkingDir?.trim() || null;
    if (!workingDir) continue;
    const existing = byName.get(name);
    if (existing?.workingDir) continue;
    byName.set(name, {
      name,
      workingDir,
      configFiles: container.composeConfigFiles?.trim() || null,
      serviceCount: 0,
      containerCount: 0,
      runningContainerCount: 0,
      services: [],
    });
  }
  const projects = [...byName.values()];
  if (projects.length === 0) return 0;
  warmComposeMetaCache(connectionId, projects);
  debugCompose("warmComposeMetaFromContainers", {
    connectionId,
    warmed: projects.length,
    sample: projects.slice(0, 3).map((p) => ({
      name: p.name,
      workingDir: p.workingDir,
      configFiles: p.configFiles,
    })),
  });
  return projects.length;
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
  const span = beginComposeDebug("getComposeProjectMeta", {
    connectionId,
    project: projectName,
  });
  const key = composeMetaCacheKey(connectionId, projectName);
  const cached = composeMetaCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < COMPOSE_META_TTL_MS) {
    span.end("命中 meta 缓存", {
      workingDir: cached.meta.workingDir,
      configFiles: cached.meta.configFiles,
    });
    return cached.meta;
  }
  span.step("缓存未命中，拉取全量项目列表");
  const projects = await fetchComposeProjects(connectionId);
  const meta = findComposeProjectMeta(projects, projectName);
  span.end("从全量列表解析 meta", {
    found: Boolean(meta),
    workingDir: meta?.workingDir,
    configFiles: meta?.configFiles,
    projectCount: projects.length,
  });
  return meta;
}

export function invalidateComposeProjectMeta(connectionId: string, projectName?: string): void {
  if (projectName) {
    composeMetaCache.delete(composeMetaCacheKey(connectionId, projectName));
    invalidateComposeFilesCache(connectionId, projectName);
    return;
  }
  composeProjectsListCache.delete(connectionId);
  for (const key of composeMetaCache.keys()) {
    if (key.startsWith(`${connectionId}::`)) {
      composeMetaCache.delete(key);
    }
  }
  invalidateComposeFilesCache(connectionId);
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
      ageMs: Date.now() - cached.fetchedAt,
    });
    return cached.projects;
  }
  const inflight = fetchComposeProjectsInflight.get(connectionId);
  if (inflight) {
    debugCompose("fetchComposeProjects 合并进行中的 IPC", { connectionId });
    return inflight;
  }
  const span = beginComposeDebug("fetchComposeProjects", { connectionId });
  const promise = (async () => {
    try {
      return await runWithDockerBoundSsh(connectionId, async () => {
        span.step("IPC dockerListComposeProjects 发出");
        const projects = await unwrap(commands.dockerListComposeProjects(connectionId), DOCKER_QUIET_IPC);
        span.end("IPC 返回", { connectionId, count: projects.length });
        composeProjectsListCache.set(connectionId, { projects, fetchedAt: Date.now() });
        warmComposeMetaCache(connectionId, projects);
        return projects;
      });
    } catch (error) {
      span.end("失败", { error: String(error) });
      handleDockerAutoFetchFailure(connectionId, error);
      throw error;
    } finally {
      fetchComposeProjectsInflight.delete(connectionId);
    }
  })();
  fetchComposeProjectsInflight.set(connectionId, promise);
  return promise;
}

function readComposeFilesInflightKey(
  connectionId: string,
  request: DockerComposeReadFilesRequest,
): string {
  return [
    connectionId,
    request.project.trim(),
    request.workingDir?.trim() ?? "",
    request.configFile?.trim() ?? "",
  ].join("::");
}

export async function readComposeProjectFiles(
  connectionId: string,
  request: DockerComposeReadFilesRequest,
  options?: { force?: boolean },
): Promise<DockerComposeProjectFiles> {
  const project = request.project.trim();
  if (!options?.force) {
    const cached = peekComposeFilesCache(connectionId, project);
    if (
      cached &&
      isComposeFilesCacheFresh(cached) &&
      (!request.workingDir || !cached.workingDir || request.workingDir === cached.workingDir)
    ) {
      debugCompose("readComposeProjectFiles 命中新鲜内容缓存", {
        connectionId,
        project,
        ageMs: Date.now() - cached.fetchedAt,
        composeBytes: cached.files.composeContent.length,
        envBytes: cached.files.envContent.length,
      });
      return cached.files;
    }
  }
  const inflightKey = readComposeFilesInflightKey(connectionId, request);
  const inflight = readComposeFilesInflight.get(inflightKey);
  if (inflight) {
    debugCompose("readComposeProjectFiles 合并进行中的 IPC", {
      connectionId,
      project: request.project,
      workingDir: request.workingDir,
    });
    return inflight;
  }
  const span = beginComposeDebug("readComposeProjectFiles", {
    connectionId,
    project: request.project,
    workingDir: request.workingDir,
    configFile: request.configFile,
    force: Boolean(options?.force),
  });
  const promise = (async () => {
    try {
      return await runWithDockerBoundSsh(connectionId, async () => {
        span.step("IPC dockerReadComposeFiles 发出");
        const files = await unwrap(commands.dockerReadComposeFiles(connectionId, request));
        writeComposeFilesCache(connectionId, project, files, {
          workingDir: request.workingDir ?? files.workingDir,
          configFile: request.configFile,
        });
        span.end("IPC 返回", {
          composePath: files.composePath,
          envPath: files.envPath,
          composeBytes: files.composeContent.length,
          envBytes: files.envContent.length,
          composePreview: files.composeContent.slice(0, 120),
          envPreview: files.envContent.slice(0, 120),
        });
        return files;
      });
    } catch (error) {
      span.end("失败", {
        connectionId,
        project: request.project,
        error: String(error),
      });
      throw error;
    } finally {
      readComposeFilesInflight.delete(inflightKey);
    }
  })();
  readComposeFilesInflight.set(inflightKey, promise);
  return promise;
}

/**
 * 打开 Compose Tab 前预取配置文件（依赖侧栏已预热的 workingDir）。
 * 面板 loadFiles 可命中内容缓存，体感接近秒开。
 */
export function prefetchComposeProjectFiles(connectionId: string, projectName: string): void {
  const project = projectName.trim();
  if (!project) return;
  const meta = peekComposeProjectMeta(connectionId, project);
  const workingDir = meta?.workingDir?.trim() || null;
  if (!workingDir) {
    debugCompose("prefetchComposeProjectFiles 跳过：无 workingDir", {
      connectionId,
      project,
    });
    return;
  }
  const configFile = meta?.configFiles?.split(",")[0]?.trim() || null;
  const cached = peekComposeFilesCache(connectionId, project);
  if (cached && isComposeFilesCacheFresh(cached)) {
    debugCompose("prefetchComposeProjectFiles 已有新鲜缓存", {
      connectionId,
      project,
      ageMs: Date.now() - cached.fetchedAt,
    });
    return;
  }
  const request: DockerComposeReadFilesRequest = {
    project,
    workingDir,
    configFile,
  };
  const inflightKey = readComposeFilesInflightKey(connectionId, request);
  if (readComposeFilesInflight.has(inflightKey)) {
    debugCompose("prefetchComposeProjectFiles 已有进行中请求", { connectionId, project });
    return;
  }
  debugCompose("prefetchComposeProjectFiles 开始", {
    connectionId,
    project,
    workingDir,
    configFile,
  });
  void readComposeProjectFiles(connectionId, request).catch((error) => {
    debugCompose("prefetchComposeProjectFiles 失败（忽略）", {
      connectionId,
      project,
      error: String(error),
    });
  });
}

export async function writeComposeProjectFiles(
  connectionId: string,
  request: DockerComposeWriteFilesRequest,
): Promise<void> {
  await runWithDockerBoundSsh(connectionId, () =>
    unwrap(commands.dockerWriteComposeFiles(connectionId, request)),
  );
  const existing = peekComposeFilesCache(connectionId, request.project);
  writeComposeFilesCache(
    connectionId,
    request.project,
    {
      project: request.project,
      workingDir: request.workingDir ?? existing?.files.workingDir ?? null,
      composePath:
        request.composePath != null && request.composePath !== ""
          ? request.composePath
          : (existing?.files.composePath ?? ""),
      composeContent:
        request.composeContent != null
          ? request.composeContent
          : (existing?.files.composeContent ?? ""),
      envPath:
        request.envPath != null && request.envPath !== ""
          ? request.envPath
          : (existing?.files.envPath ?? ""),
      envContent:
        request.envContent != null ? request.envContent : (existing?.files.envContent ?? ""),
    },
    {
      workingDir: request.workingDir ?? existing?.workingDir ?? null,
      configFile: request.configFile ?? existing?.configFile ?? null,
    },
  );
}

export async function runComposeAction(
  connectionId: string,
  action: "up" | "stop" | "down" | "restart" | "rebuild" | "pull" | "logs",
  request: DockerComposeRequest,
  options?: { skipPresence?: boolean },
): Promise<DockerComposeResult> {
  let token: string | null = null;
  if ((action === "down" || action === "rebuild") && !options?.skipPresence) {
    const { ACTION_DOCKER_COMPOSE_DOWN, pipeTarget } = await import("../../lib/presenceTargets");
    const { requireStepUp } = await import("../../lib/stepUp");
    const issued = await requireStepUp({
      action: ACTION_DOCKER_COMPOSE_DOWN,
      target: pipeTarget(connectionId, request.project),
      title: action === "rebuild" ? "重建 Compose" : "Compose Down",
      message: `即将对项目「${request.project}」执行 ${action}`,
      reason: `${action} ${request.project}`,
    });
    if (!issued) {
      throw new Error("已取消");
    }
    token = issued;
  }
  return runWithDockerBoundSsh(connectionId, () =>
    unwrap(commands.dockerComposeAction(connectionId, action, request, token)),
  );
}

export function findComposeProjectMeta(
  projects: DockerComposeProject[],
  projectName: string,
): DockerComposeProject | undefined {
  const needle = projectName.trim();
  return projects.find((item) => item.name === needle);
}
