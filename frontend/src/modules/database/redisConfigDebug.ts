/** Redis 配置文件探测调试（开发环境默认开启，或 localStorage 手动开启） */
export const REDIS_CONFIG_DEBUG =
  import.meta.env.DEV ||
  (typeof localStorage !== "undefined" &&
    localStorage.getItem("omnipanel-redis-config-debug") === "1");

const TAG = "[redis-config]";

export function redisConfigLog(
  step: string,
  data?: Record<string, unknown>,
): void {
  if (!REDIS_CONFIG_DEBUG) {
    return;
  }
  if (data && Object.keys(data).length > 0) {
    console.log(TAG, step, data);
  } else {
    console.log(TAG, step);
  }
}

export function redisConfigWarn(
  step: string,
  data?: Record<string, unknown>,
): void {
  if (!REDIS_CONFIG_DEBUG) {
    return;
  }
  if (data && Object.keys(data).length > 0) {
    console.warn(TAG, step, data);
  } else {
    console.warn(TAG, step);
  }
}

export function summarizeDeployment(deployment: {
  kind?: string;
  dir?: string;
  pidFile?: string;
  sshConnectionId?: string;
  containerId?: string;
  containerName?: string;
  locationTag?: string;
  reason?: string;
}): Record<string, unknown> {
  return {
    kind: deployment.kind,
    dir: deployment.dir ?? "",
    pidFile: deployment.pidFile ?? "",
    sshConnectionId: deployment.sshConnectionId ?? "",
    containerId: deployment.containerId ?? "",
    containerName: deployment.containerName ?? "",
    locationTag: deployment.locationTag ?? "",
    reason: deployment.reason ?? "",
  };
}
