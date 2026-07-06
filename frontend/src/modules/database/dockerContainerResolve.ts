/** docker ps --format 行：CONTAINER_ID\tNAMES */
export interface DockerContainerRef {
  id: string;
  name: string;
}

/** 解析 `docker ps --format '{{.ID}}\t{{.Names}}'` 输出。 */
export function parseDockerPsFormatLine(line: string): DockerContainerRef | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  const tab = trimmed.indexOf("\t");
  if (tab > 0) {
    const id = trimmed.slice(0, tab).trim();
    const name = trimmed.slice(tab + 1).trim();
    if (id && name) {
      return { id, name };
    }
  }
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    return null;
  }
  return { id: parts[0], name: parts[parts.length - 1] };
}

/** 判断字符串是否更像镜像引用（mysql:9.2.0）而非容器名。 */
export function looksLikeDockerImageRef(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || !trimmed.includes(":")) {
    return false;
  }
  if (/^[a-f0-9]{12,64}$/i.test(trimmed)) {
    return false;
  }
  return /^[a-z0-9][a-z0-9._/-]*:[a-z0-9][a-z0-9._-]*$/i.test(trimmed);
}

/**
 * 选择 docker exec 目标：优先短 ID，避免误用镜像名。
 */
export function resolveDockerExecTarget(input: {
  containerId?: string | null;
  containerName?: string | null;
  locationTag?: string | null;
}): string | null {
  const id = input.containerId?.trim();
  if (id) {
    return id;
  }
  const name = input.containerName?.trim();
  if (name && !looksLikeDockerImageRef(name)) {
    return name;
  }
  const location = input.locationTag?.trim();
  if (location && !looksLikeDockerImageRef(location)) {
    return location;
  }
  return name || null;
}

/** 构造按宿主机端口查找容器的 docker ps 命令。 */
export function buildFindDockerContainerByPortCommand(port: number): string {
  return `docker ps --filter publish=${port} --format '{{.ID}}\t{{.Names}}' 2>/dev/null | head -1`;
}

/** 端口过滤无结果时的回退：在 Ports 列中匹配宿主机端口。 */
export function buildFindDockerContainerByPortFallbackCommand(port: number): string {
  const needle = `:${port}`;
  const quoted = `'${needle.replace(/'/g, `'\\''`)}'`;
  return `docker ps --format '{{.ID}}\t{{.Names}}\t{{.Ports}}' 2>/dev/null | grep ${quoted} | head -1`;
}

export function parseDockerPsPortsFallbackLine(line: string): DockerContainerRef | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  const parts = trimmed.split("\t");
  if (parts.length >= 2) {
    const id = parts[0]?.trim();
    const name = parts[1]?.trim();
    if (id && name) {
      return { id, name };
    }
  }
  return parseDockerPsFormatLine(line);
}
