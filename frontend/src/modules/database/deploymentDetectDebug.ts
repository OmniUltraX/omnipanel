import type { DbConnectionConfig } from "./api";

/** 部署方式探测调试（开发环境默认开启，�?localStorage 手动开启） */
export const DEPLOYMENT_DETECT_DEBUG =
  import.meta.env.DEV ||
  (typeof localStorage !== "undefined" &&
    localStorage.getItem("omnipanel-deployment-detect-debug") === "1");

export type DeploymentDetectService = "mysql" | "redis" | "postgresql";

const TAG = "[deploy-detect]";

function truncate(value: string, max = 500): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}�?+${trimmed.length - max} chars)`;
}

export function deployDetectLog(
  service: DeploymentDetectService,
  step: string,
  data?: Record<string, unknown>,
): void {
  if (!DEPLOYMENT_DETECT_DEBUG) {
    return;
  }
  if (data && Object.keys(data).length > 0) {
    console.log(TAG, service, step, data);
  } else {
    console.log(TAG, service, step);
  }
}

export function deployDetectWarn(
  service: DeploymentDetectService,
  step: string,
  data?: Record<string, unknown>,
): void {
  if (!DEPLOYMENT_DETECT_DEBUG) {
    return;
  }
  if (data && Object.keys(data).length > 0) {
    console.warn(TAG, service, step, data);
  } else {
    console.warn(TAG, service, step);
  }
}

export function summarizeDbConnection(
  connection: Pick<DbConnectionConfig, "id" | "name" | "host" | "port" | "db_type">,
): Record<string, unknown> {
  return {
    id: connection.id,
    name: connection.name,
    host: connection.host,
    port: connection.port,
    dbType: connection.db_type,
  };
}

export function summarizeDeploymentInfo(deployment: {
  kind?: string;
  reason?: string;
  locationTag?: string;
  pidFile?: string;
  dir?: string;
  basedir?: string;
  datadir?: string;
  sshConnectionId?: string;
  serverName?: string;
  containerId?: string;
  containerName?: string;
}): Record<string, unknown> {
  return {
    kind: deployment.kind ?? "",
    reason: deployment.reason ?? "",
    locationTag: deployment.locationTag ?? "",
    pidFile: deployment.pidFile ?? "",
    dir: deployment.dir ?? "",
    basedir: deployment.basedir ?? "",
    datadir: deployment.datadir ?? "",
    sshConnectionId: deployment.sshConnectionId ?? "",
    serverName: deployment.serverName ?? "",
    containerId: deployment.containerId ?? "",
    containerName: deployment.containerName ?? "",
  };
}

export function summarizeSshExecResult(result: {
  stdout: string;
  stderr: string;
}): Record<string, unknown> {
  return {
    stdout: truncate(result.stdout),
    stderr: truncate(result.stderr, 200),
  };
}
