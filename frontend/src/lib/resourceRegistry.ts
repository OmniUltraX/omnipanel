// 连接资源的「真相源」已迁移到后端统一连接模型（omnipanel-store）+ 前端 connectionStore。
// 本文件保留类型/标签常量与纯函数 helper；下方 SEED_RESOURCES 仅作后端无数据时的空态占位（fallback），
// 各功能面板将在对应里程碑（SSH/数据库等）逐步改用 connectionStore 的真实数据。

import { getCachedOpenSshHosts, getOpenSshHostResource } from "./sshConfigHosts";

export type ResourceType =
  | "workspace"
  | "terminal"
  | "ssh"
  | "database"
  | "docker"
  | "server"
  | "protocol";

export type EnvironmentTag = "prod" | "staging" | "dev" | "local" | "unknown";

export type ResourceStatus = "online" | "warning" | "offline" | "running" | "idle";

export interface WorkspaceResource {
  id: string;
  type: ResourceType;
  name: string;
  subtitle: string;
  modulePath: string;
  environment: EnvironmentTag;
  status: ResourceStatus;
  /** SSH 等连接的分组名（如 默认 / 生产 / ~/.ssh/config）。 */
  group?: string;
  tags?: string[];
  metrics?: Record<string, string>;
}

export const ENVIRONMENT_LABELS: Record<EnvironmentTag, string> = {
  prod: "生产",
  staging: "预发",
  dev: "开发",
  local: "本地",
  unknown: "未知",
};

export const RESOURCE_TYPE_LABELS: Record<ResourceType, string> = {
  workspace: "工作区",
  terminal: "终端",
  ssh: "SSH",
  database: "数据库",
  docker: "容器",
  server: "服务器",
  protocol: "协议",
};

/** 空态占位数据（fallback）。真实连接来自 connectionStore；后端无数据时用于展示。 */
export const SEED_RESOURCES: WorkspaceResource[] = [
  {
    id: "local-terminal",
    type: "terminal",
    name: "本地终端",
    subtitle: "PowerShell · c:\\Users\\chaoj\\dev\\omnipanel",
    modulePath: "/terminal",
    environment: "local",
    status: "running",
    tags: ["PTY", "Blocks"],
  },
  {
    id: "prod-web-01",
    type: "ssh",
    name: "prod-web-01",
    subtitle: "deploy@192.168.1.100:22",
    modulePath: "/ssh",
    environment: "prod",
    status: "online",
    group: "生产",
    tags: ["SSH", "SFTP", "Tunnel"],
    metrics: { CPU: "23%", MEM: "78%" },
  },
  {
    id: "prod-web-02",
    type: "ssh",
    name: "prod-web-02",
    subtitle: "deploy@192.168.1.101:22",
    modulePath: "/ssh",
    environment: "prod",
    status: "online",
    group: "生产",
    tags: ["SSH", "Canary", "Tunnel"],
    metrics: { CPU: "18%", MEM: "46%" },
  },
  {
    id: "staging-bastion",
    type: "ssh",
    name: "staging-bastion",
    subtitle: "ops@10.0.8.12:22",
    modulePath: "/ssh",
    environment: "staging",
    status: "warning",
    group: "预发",
    tags: ["Bastion", "SSH", "Audit"],
    metrics: { CPU: "31%", MEM: "52%" },
  },
  {
    id: "prod-db-master",
    type: "database",
    name: "postgres-main",
    subtitle: "PostgreSQL 16 · orders / users / billing",
    modulePath: "/database",
    environment: "prod",
    status: "warning",
    tags: ["SQL", "只读建议"],
    metrics: { QPS: "1.2k", 延迟: "18ms" },
  },
  {
    id: "redis-cache-db",
    type: "database",
    name: "redis-cache",
    subtitle: "Redis 7 · cache layer",
    modulePath: "/database",
    environment: "prod",
    status: "online",
    tags: ["Cache", "KV"],
  },
  {
    id: "docker-prod-web",
    type: "docker",
    name: "prod-web-01",
    subtitle: "远程 Docker · 6 容器",
    modulePath: "/docker",
    environment: "prod",
    status: "online",
    tags: ["Remote", "Compose"],
  },
  {
    id: "docker-staging-api",
    type: "docker",
    name: "staging-api",
    subtitle: "远程 Docker · 4 容器",
    modulePath: "/docker",
    environment: "staging",
    status: "online",
    tags: ["Remote", "Logs"],
  },
  {
    id: "docker-local",
    type: "docker",
    name: "dev-local",
    subtitle: "4 个运行容器 · 2 个停止容器",
    modulePath: "/docker",
    environment: "dev",
    status: "online",
    tags: ["Compose", "Logs"],
    metrics: { 容器: "6", 镜像: "12" },
  },
  {
    id: "staging-api",
    type: "ssh",
    name: "staging-api",
    subtitle: "ubuntu@10.0.2.15:22",
    modulePath: "/ssh",
    environment: "staging",
    status: "online",
    tags: ["SSH", "SFTP"],
    metrics: { CPU: "67%", 磁盘: "92%" },
  },
  {
    id: "staging-api-server",
    type: "server",
    name: "staging-api",
    subtitle: "Ubuntu 22.04 · API 与 worker",
    modulePath: "/server",
    environment: "staging",
    status: "warning",
    tags: ["监控", "日志"],
    metrics: { CPU: "67%", 磁盘: "92%" },
  },
  {
    id: "mqtt-lab",
    type: "protocol",
    name: "MQTT 调试会话",
    subtitle: "broker.local:1883 · topic /devices/#",
    modulePath: "/protocol",
    environment: "dev",
    status: "idle",
    tags: ["MQTT", "WebSocket"],
  },
];

/**
 * @deprecated 仅作过渡兼容别名。新代码请用 connectionStore（真实数据）或 SEED_RESOURCES（空态）。
 */
export const workspaceResources = SEED_RESOURCES;

export function getResourceById(id: string | null | undefined) {
  if (!id) return null;
  const fromConfig = getOpenSshHostResource(id);
  if (fromConfig) return fromConfig;
  return SEED_RESOURCES.find((resource) => resource.id === id) ?? null;
}

export function getSshHosts() {
  const cached = getCachedOpenSshHosts();
  if (cached.length > 0) return cached;
  return SEED_RESOURCES.filter((resource) => resource.type === "ssh");
}

/** 服务器监控侧栏：SSH 主机 + server 类型，按名称去重（优先 server 条目）。 */
export function getServerMonitorResources(resources: WorkspaceResource[] = SEED_RESOURCES): WorkspaceResource[] {
  const candidates = resources.filter((resource) => resource.type === "server" || resource.type === "ssh");
  const byName = new Map<string, WorkspaceResource>();
  for (const resource of candidates) {
    const key = resource.name.toLowerCase();
    const existing = byName.get(key);
    if (!existing || (resource.type === "server" && existing.type === "ssh")) {
      byName.set(key, resource);
    }
  }
  return Array.from(byName.values());
}

export function getResourcesByPath(pathname: string) {
  if (pathname === "/") return SEED_RESOURCES;
  if (pathname === "/server") return getServerMonitorResources();
  return SEED_RESOURCES.filter((resource) => resource.modulePath === pathname);
}

export function getDefaultResourceForPath(pathname: string) {
  return getResourcesByPath(pathname)[0] ?? SEED_RESOURCES[0] ?? null;
}
