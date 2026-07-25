/**
 * Docker 实例不可达时的静默降级：标记 offline，避免 IPC console.error 刷屏。
 */

type OfflineHandler = (connectionId: string) => void;

let offlineHandler: OfflineHandler | null = null;

/** 由 Docker 面板注册；侧栏刷新等非 React 路径可调用 markDockerConnectionOffline。 */
export function registerDockerOfflineHandler(handler: OfflineHandler | null): void {
  offlineHandler = handler;
}

/** 将指定 Docker 连接标记为未连接（offline）。 */
export function markDockerConnectionOffline(connectionId: string): void {
  const id = connectionId.trim();
  if (!id) return;
  offlineHandler?.(id);
}

/** 判断是否为「连不上实例」类错误（SSH / 通道 / 连接超时等）。 */
export function isDockerUnavailableError(error: unknown): boolean {
  if (error == null) return false;

  if (typeof error === "object") {
    const err = error as {
      code?: string | null;
      message?: string | null;
      cause?: string | null;
    };
    const code = (err.code ?? "").toLowerCase();
    if (code === "ssh" || code === "connection") return true;
    const text = `${err.message ?? ""} ${err.cause ?? ""}`;
    if (matchesUnavailableText(text)) return true;
  }

  return matchesUnavailableText(String(error));
}

function matchesUnavailableText(text: string): boolean {
  return /打开 SSH|Channel send|channel open|connection reset|broken pipe|会话不可用|连接失败|timed?\s*out|超时|unreachable|ECONNREFUSED|ECONNRESET|ConnectException|SSH 会话/i.test(
    text,
  );
}

/** 自动探测 / 列表类 IPC：失败时不打 console.error。 */
export const DOCKER_QUIET_IPC = { quiet: true as const };

/**
 * 处理自动拉取失败：不可达则静默标记 offline 并返回 true（调用方勿再展示错误）。
 */
export function handleDockerAutoFetchFailure(connectionId: string, error: unknown): boolean {
  if (!isDockerUnavailableError(error)) return false;
  markDockerConnectionOffline(connectionId);
  return true;
}
