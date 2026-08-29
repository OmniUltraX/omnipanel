/**
 * 确保本机拥有指定团队的同步密钥：先查本地，再走团队 mesh TCP，失败则 HTTP 中继，再失败则强制引导导入。
 */

import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { useAuthStore } from "../../stores/authStore";
import { useSyncDeviceAuthStore } from "../../stores/syncDeviceAuthStore";
import { getCurrentSyncTeamId } from "../../stores/currentSyncTeamStore";
import { getSyncTeamKeyStatus } from "./syncTeamKeyApi";
import {
  listOnlineSyncPeers,
  requestTeamSyncKeyFromRelay,
  SyncKeyRelayError,
  type RequestTeamSyncKeyOptions,
} from "./syncKeyRelayApi";
import { meshHostname, startTeamMesh, waitForMeshReady } from "./teamMesh";

export class TeamSyncKeyRequiredError extends Error {
  constructor(message = "需要团队同步密钥") {
    super(message);
    this.name = "TeamSyncKeyRequiredError";
  }
}

type KeyWaitEntry = {
  resolve: () => void;
  reject: (error: Error) => void;
};

const keyWaiters = new Map<number, KeyWaitEntry>();

/** 密钥对话框成功导入/中继后调用，解除 `ensureTeamSyncKeyForTeam` 的等待。 */
export function resolveTeamSyncKeyWait(teamId: number): void {
  keyWaiters.get(teamId)?.resolve();
  keyWaiters.delete(teamId);
}

export function rejectTeamSyncKeyWait(teamId: number, error: Error): void {
  keyWaiters.get(teamId)?.reject(error);
  keyWaiters.delete(teamId);
}

let skipPullAfterKeyReady = false;

/** 切换组织流程中由 switchSyncTeam 自行拉取快照，避免对话框重复 pull。 */
export function setSkipPullAfterTeamKey(value: boolean): void {
  skipPullAfterKeyReady = value;
}

export function shouldSkipPullAfterTeamKey(): boolean {
  return skipPullAfterKeyReady;
}

async function resolveDeviceId(): Promise<string> {
  const identity = await unwrapCommand(commands.authDeviceIdentity(), { quiet: true });
  return identity.deviceId;
}

export async function hasTeamSyncKey(teamId: number): Promise<boolean> {
  if (!Number.isFinite(teamId) || teamId <= 0) return false;
  try {
    const status = await getSyncTeamKeyStatus(teamId);
    return status.hasKey;
  } catch {
    return false;
  }
}

async function tryMeshTeamSyncKey(teamId: number, timeoutMs: number): Promise<boolean> {
  const token = useAuthStore.getState().token?.trim();
  if (!token) return false;
  try {
    await startTeamMesh();
    await waitForMeshReady(Math.min(timeoutMs, 20_000));
    const deviceId = await resolveDeviceId();
    if (!deviceId) return false;
    const peers = await listOnlineSyncPeers(token, teamId);
    const others = peers.filter((p) => p.deviceId.trim() && p.deviceId.trim() !== deviceId);
    if (others.length === 0) return false;

    const eph = await unwrapCommand(commands.syncTeamKeyGenerateEphemeralKeypair(), {
      quiet: true,
    });
    const requestId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `mesh-${Date.now()}`;
    const deadline = Date.now() + timeoutMs;
    for (const peer of others) {
      if (Date.now() > deadline) break;
      try {
        const wrapped = await unwrapCommand(
          commands.meshRequestSyncKey(
            teamId,
            meshHostname(peer.deviceId),
            eph.publicKeyB64,
            requestId,
            deviceId,
          ),
          { quiet: true },
        );
        await unwrapCommand(
          commands.syncTeamKeyUnwrapFromRelay(
            teamId,
            wrapped,
            eph.secretKeyB64,
            requestId,
            deviceId,
          ),
          { quiet: true },
        );
        return true;
      } catch {
        /* 下一台对端或回退 HTTP 中继 */
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function tryRelayTeamSyncKey(
  teamId: number,
  timeoutMs: number,
): Promise<boolean> {
  const token = useAuthStore.getState().token?.trim();
  if (!token) return false;
  try {
    const deviceId = await resolveDeviceId();
    await requestTeamSyncKeyFromRelay({ token, teamId, deviceId, timeoutMs });
    return true;
  } catch (e) {
    if (
      e instanceof SyncKeyRelayError &&
      (e.code === "no_online_peer" || e.code === "timeout")
    ) {
      return false;
    }
    throw e;
  }
}

/**
 * 向同团队在线设备请求同步密钥：优先团队 mesh TCP（:42424），失败再走 HTTP 中继。
 */
export async function requestTeamSyncKey(
  opts: RequestTeamSyncKeyOptions,
): Promise<{ fingerprint: string }> {
  const teamId = opts.teamId ?? getCurrentSyncTeamId();
  if (!teamId || teamId <= 0) {
    throw new Error("无法解析当前同步团队");
  }

  const relayTimeoutMs = opts.timeoutMs ?? 90_000;
  if (await tryMeshTeamSyncKey(teamId, Math.min(relayTimeoutMs, 25_000))) {
    const status = await getSyncTeamKeyStatus(teamId);
    const fingerprint = status.fingerprint?.trim() ?? "";
    if (!fingerprint) {
      throw new SyncKeyRelayError("request_failed", "mesh 传钥成功但无法读取密钥指纹");
    }
    return { fingerprint };
  }

  return requestTeamSyncKeyFromRelay(opts);
}

function waitForForcedTeamSyncKey(teamId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    keyWaiters.set(teamId, { resolve, reject });
    useSyncDeviceAuthStore.getState().openForcedDialog(teamId);
  });
}

export type EnsureTeamSyncKeyOptions = {
  /** 中继等待时长（毫秒） */
  relayTimeoutMs?: number;
  /**
   * 为 true 时：中继失败后弹出不可关闭的密钥对话框，直到导入/创建成功。
   * 为 false 时：失败后仅打开普通引导对话框。
   */
  force?: boolean;
};

/**
 * 确保本机拥有 teamId 对应的团队同步密钥。
 * @returns 是否已具备密钥（force 模式下成功时恒为 true）
 */
export async function ensureTeamSyncKeyForTeam(
  teamId: number,
  options?: EnsureTeamSyncKeyOptions,
): Promise<boolean> {
  if (!Number.isFinite(teamId) || teamId <= 0) return false;

  if (await hasTeamSyncKey(teamId)) {
    useSyncDeviceAuthStore.getState().closeDialog();
    return true;
  }

  const relayTimeoutMs = options?.relayTimeoutMs ?? 60_000;
  if (await tryMeshTeamSyncKey(teamId, Math.min(relayTimeoutMs, 25_000))) {
    useSyncDeviceAuthStore.getState().closeDialog();
    return true;
  }
  if (await tryRelayTeamSyncKey(teamId, relayTimeoutMs)) {
    useSyncDeviceAuthStore.getState().closeDialog();
    return true;
  }

  if (options?.force) {
    await waitForForcedTeamSyncKey(teamId);
    if (!(await hasTeamSyncKey(teamId))) {
      throw new TeamSyncKeyRequiredError();
    }
    return true;
  }

  useSyncDeviceAuthStore.getState().openDialog();
  return false;
}
