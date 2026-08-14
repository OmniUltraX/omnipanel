/**
 * Docker 实例依赖的绑定 SSH：未打开时先确认，用户同意后再建立会话并允许重试原操作。
 */
import { commands } from "../../ipc/bindings";
import { formatIpcError } from "../../ipc/result";
import { appAlert } from "../../lib/appAlert";
import { appConfirm } from "../../lib/appConfirm";
import { ensureSshReady, isSshConnectionEstablished } from "../database/mysqlSlowQueryLog";
import { useConnectionStore } from "../../stores/connectionStore";
import {
  loadSshPoolActiveSessions,
  useSshConnectionStore,
} from "../../stores/sshConnectionStore";
import { useTerminalStore } from "../../stores/terminalStore";

const MISSING_BOUND_SSH_RE = /必须绑定\s*SSH\s*连接/i;
const SSH_NEED_OPEN_RE =
  /打开 SSH|会话不可用|SSH 会话|Channel send|channel open|connection reset|broken pipe|ECONNREFUSED|ECONNRESET/i;

/** 启动期监控恢复 / 连接池预热时，短暂等待建连完成再决定是否弹窗。 */
const BOUND_SSH_WAIT_MS = 6000;
const BOUND_SSH_POLL_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function markBoundSshSessionActive(sshId: string): void {
  useSshConnectionStore.getState().setSessionActive(sshId, true);
}

async function probeBoundSshPool(sshId: string): Promise<boolean> {
  try {
    const stats = await commands.sshPoolFetchStats(sshId);
    if (stats.status === "ok") {
      markBoundSshSessionActive(sshId);
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

function isSshConnectionInProgress(sshId: string): boolean {
  const poolStatus = useSshConnectionStore.getState().statusMap[sshId]?.status;
  if (poolStatus === "connecting") return true;

  const embeddedPanes = useTerminalStore.getState().embeddedPanes;
  for (const pane of Object.values(embeddedPanes)) {
    if (pane.resourceId === sshId && pane.type === "remote" && pane.status === "connecting") {
      return true;
    }
  }
  const tabs = useTerminalStore.getState().tabs;
  for (const tab of tabs) {
    if (
      tab.session.resourceId === sshId &&
      tab.session.type === "remote" &&
      tab.status === "connecting"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 启动后自定义看板可能早于 SSH 池快照/监控恢复：先静默探测并等待建连，
 * 避免「尚未打开」确认框与后台已成功的数据加载互相矛盾。
 */
async function tryEstablishBoundSshSilently(sshId: string): Promise<boolean> {
  if (isSshConnectionEstablished(sshId)) return true;

  await loadSshPoolActiveSessions();
  if (isSshConnectionEstablished(sshId)) return true;
  if (await probeBoundSshPool(sshId)) return true;

  const deadline = Date.now() + BOUND_SSH_WAIT_MS;
  while (Date.now() < deadline) {
    if (isSshConnectionEstablished(sshId)) return true;
    if (await probeBoundSshPool(sshId)) return true;

    const inProgress = isSshConnectionInProgress(sshId) || ensureInflight.has(sshId);
    if (!inProgress) break;

    await sleep(BOUND_SSH_POLL_MS);
  }

  if (isSshConnectionEstablished(sshId)) return true;
  if (await probeBoundSshPool(sshId)) return true;

  const ready = await ensureSshReady(sshId);
  if (ready) {
    markBoundSshSessionActive(sshId);
    return true;
  }
  return isSshConnectionEstablished(sshId);
}

async function openBoundSshAfterConfirm(sshId: string): Promise<boolean> {
  if (await probeBoundSshPool(sshId)) return true;

  const ready = await ensureSshReady(sshId);
  if (ready) {
    markBoundSshSessionActive(sshId);
    return true;
  }

  await appAlert("打开依赖的 SSH 连接失败，请检查凭据后重试。", "OmniPanel", {
    kind: "error",
  });
  return false;
}

export type DockerBoundSshHint = {
  /** 列表探针已带回的绑定 id，优先于本地 config 解析 */
  boundSshConnectionId?: string | null;
};

/** 解析 Docker 连接配置中的绑定 SSH id。 */
export function resolveDockerBoundSshId(
  dockerConnectionId: string,
  hint?: DockerBoundSshHint | string | null,
): string | null {
  if (typeof hint === "string") {
    const trimmed = hint.trim();
    if (trimmed) return trimmed;
  } else if (hint?.boundSshConnectionId?.trim()) {
    return hint.boundSshConnectionId.trim();
  }

  const id = dockerConnectionId.trim();
  if (!id) return null;
  const conn = useConnectionStore
    .getState()
    .connections.find((c) => c.id === id && c.kind === "docker");
  if (!conn?.config) return null;
  try {
    const cfg = JSON.parse(conn.config) as { boundSshConnectionId?: unknown };
    if (typeof cfg.boundSshConnectionId !== "string") return null;
    const sshId = cfg.boundSshConnectionId.trim();
    return sshId || null;
  } catch {
    return null;
  }
}

export function isMissingDockerBoundSshError(error: unknown): boolean {
  return MISSING_BOUND_SSH_RE.test(formatIpcError(error));
}

function isSshNeedOpenError(error: unknown): boolean {
  const text = formatIpcError(error);
  return MISSING_BOUND_SSH_RE.test(text) || SSH_NEED_OPEN_RE.test(text);
}

/** 同一 SSH 并发确保时合并为一次确认 / 建连。 */
const ensureInflight = new Map<string, Promise<boolean>>();

/**
 * 若绑定 SSH 尚未建立会话，弹出确认框；用户同意则打开连接。
 * @returns true 表示可继续原逻辑；false 表示用户取消或打开失败
 */
export async function ensureDockerBoundSshOpen(
  boundSshConnectionId: string | null | undefined,
): Promise<boolean> {
  const sshId = boundSshConnectionId?.trim() ?? "";
  if (!sshId) return true;
  if (isSshConnectionEstablished(sshId)) return true;

  const existing = ensureInflight.get(sshId);
  if (existing) return existing;

  const task = (async () => {
    if (isSshConnectionEstablished(sshId)) return true;
    if (await tryEstablishBoundSshSilently(sshId)) return true;

    const confirmed = await appConfirm(
      "该实例所依赖的SSH连接尚未打开，是否立即打开？",
      "OmniPanel",
      {
        kind: "warning",
        confirmLabel: "打开",
        cancelLabel: "取消",
      },
    );
    if (!confirmed) return false;

    return openBoundSshAfterConfirm(sshId);
  })().finally(() => {
    ensureInflight.delete(sshId);
  });

  ensureInflight.set(sshId, task);
  return task;
}

/**
 * Docker 操作前：若配置了绑定 SSH 且未打开，则确认并打开。
 * 未配置绑定时返回 true，交由后端报错或后续 recover 处理。
 */
export async function prepareDockerBoundSsh(
  dockerConnectionId: string,
  hint?: DockerBoundSshHint | string | null,
): Promise<boolean> {
  const sshId = resolveDockerBoundSshId(dockerConnectionId, hint);
  return ensureDockerBoundSshOpen(sshId);
}

/**
 * 捕获「必须绑定 SSH / 会话未就绪」类错误时：尝试打开绑定 SSH，成功则返回 true 供调用方重试。
 * 无绑定配置时提示用户去编辑连接。
 */
export async function recoverDockerBoundSshFromError(
  dockerConnectionId: string,
  error: unknown,
  hint?: DockerBoundSshHint | string | null,
): Promise<boolean> {
  if (!isSshNeedOpenError(error)) return false;

  const sshId = resolveDockerBoundSshId(dockerConnectionId, hint);
  if (!sshId) {
    if (isMissingDockerBoundSshError(error)) {
      await appAlert(
        "该 Docker 连接尚未绑定 SSH 连接（用于无面板接口时的能力回退）。请编辑连接并选择绑定的 SSH 后重试。",
        "OmniPanel",
        { kind: "warning" },
      );
    }
    return false;
  }

  if (isSshConnectionEstablished(sshId)) {
    // 已打开仍报错：多半是真缺绑定字段或其它问题，避免死循环重试
    if (isMissingDockerBoundSshError(error)) {
      await appAlert(
        "该 Docker 连接配置缺少绑定的 SSH 连接。请编辑连接并重新选择绑定的 SSH 后保存。",
        "OmniPanel",
        { kind: "warning" },
      );
      return false;
    }
    return false;
  }

  return ensureDockerBoundSshOpen(sshId);
}

/**
 * 执行 Docker 操作：预先确保绑定 SSH；若因 SSH 依赖失败则打开后重试一次。
 */
export async function runWithDockerBoundSsh<T>(
  dockerConnectionId: string,
  action: () => Promise<T>,
  hint?: DockerBoundSshHint | string | null,
): Promise<T> {
  if (!(await prepareDockerBoundSsh(dockerConnectionId, hint))) {
    throw Object.assign(new Error("已取消打开依赖的 SSH 连接"), {
      code: "cancelled",
    });
  }

  try {
    return await action();
  } catch (error) {
    if (!(await recoverDockerBoundSshFromError(dockerConnectionId, error, hint))) {
      throw error;
    }
    return await action();
  }
}
