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

export const workspaceResources: WorkspaceResource[] = [
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
    tags: ["SSH", "SFTP"],
    metrics: { CPU: "23%", MEM: "78%" },
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

export function getResourceById(id: string | null | undefined) {
  if (!id) return null;
  return workspaceResources.find((resource) => resource.id === id) ?? null;
}

export function getResourcesByPath(pathname: string) {
  if (pathname === "/") return workspaceResources;
  return workspaceResources.filter((resource) => resource.modulePath === pathname);
}

export function getDefaultResourceForPath(pathname: string) {
  return getResourcesByPath(pathname)[0] ?? workspaceResources[0] ?? null;
}
