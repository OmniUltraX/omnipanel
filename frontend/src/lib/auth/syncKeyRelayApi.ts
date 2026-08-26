/**
 * omniserver 团队同步密钥中继（§4.2）。
 * WebRTC P2P 传钥 ICE 配置见 `syncKeyP2p.ts`（信令接入后优先走 P2P，失败再回落本模块）。
 */
export {
  createSyncKeyPeerConnection,
  getSyncKeyP2pIceServers,
  isSyncKeyP2pSupported,
} from "./syncKeyP2p";
import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { getCurrentSyncTeamId } from "../../stores/currentSyncTeamStore";
import { importSyncTeamKeyFile } from "./syncTeamKeyApi";

const AUTH_ASSET_BASE = "https://mp.99.protected.fun";

export type SyncKeyRelayErrorCode = "no_online_peer" | "request_failed" | "timeout";

export class SyncKeyRelayError extends Error {
  readonly code: SyncKeyRelayErrorCode;

  constructor(code: SyncKeyRelayErrorCode, message: string) {
    super(message);
    this.name = "SyncKeyRelayError";
    this.code = code;
  }
}

export interface RequestTeamSyncKeyOptions {
  token: string;
  teamId?: number | null;
  deviceId: string;
  timeoutMs?: number;
}

export type PendingKeyRelayItem = {
  requestId: string;
  teamId: number;
  requesterDeviceId: string;
  ephemeralPubkey: string;
  wrapAlg?: string;
  createdAt?: string;
};

export type OnlineSyncPeer = {
  appId: string;
  deviceId: string;
  deviceName?: string;
  platform?: string;
  syncTrusted?: boolean;
};

async function authFetch(
  token: string,
  path: string,
  init?: RequestInit & { deviceId?: string },
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("X-App-Id", "omni-client");
  if (init?.deviceId) headers.set("X-Device-Id", init.deviceId);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${AUTH_ASSET_BASE}${path}`, { ...init, headers });
}

export async function listPendingKeyRelays(token: string): Promise<PendingKeyRelayItem[]> {
  const res = await authFetch(token, "/api/sync/key/pending", { method: "GET" });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `list pending failed: ${res.status}`);
  }
  const body = (await res.json()) as {
    items?: Array<Record<string, unknown>>;
  };
  return (body.items ?? []).map((raw) => ({
    requestId: String(raw.requestId ?? raw.request_id ?? ""),
    teamId: Number(raw.teamId ?? raw.team_id ?? 0),
    requesterDeviceId: String(raw.requesterDeviceId ?? raw.requester_device_id ?? ""),
    ephemeralPubkey: String(raw.ephemeralPubkey ?? raw.ephemeral_pubkey ?? ""),
    wrapAlg: String(raw.wrapAlg ?? raw.wrap_alg ?? ""),
    createdAt: String(raw.createdAt ?? raw.created_at ?? ""),
  })).filter((item) => item.requestId && item.teamId > 0 && item.ephemeralPubkey);
}

export async function relayTeamSyncKey(
  token: string,
  args: { requestId: string; wrappedKey: string; wrapAlg?: string },
): Promise<void> {
  const res = await authFetch(token, "/api/sync/key/relay", {
    method: "POST",
    body: JSON.stringify({
      requestId: args.requestId,
      wrappedKey: args.wrappedKey,
      wrapAlg: args.wrapAlg ?? "x25519-aes256gcm-v1",
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `relay failed: ${res.status}`);
  }
}

export async function cancelKeyRelayRequest(
  token: string,
  deviceId: string,
  requestId: string,
): Promise<void> {
  const res = await authFetch(token, "/api/sync/key/cancel", {
    method: "POST",
    deviceId,
    body: JSON.stringify({ requestId }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `cancel failed: ${res.status}`);
  }
}

export async function listOnlineSyncPeers(token: string): Promise<OnlineSyncPeer[]> {
  const res = await authFetch(token, "/api/sync/peers/online", { method: "GET" });
  if (!res.ok) {
    return [];
  }
  const body = (await res.json()) as { items?: Array<Record<string, unknown>> };
  return (body.items ?? []).map((raw) => ({
    appId: String(raw.appId ?? raw.app_id ?? ""),
    deviceId: String(raw.deviceId ?? raw.device_id ?? ""),
    deviceName: String(raw.deviceName ?? raw.device_name ?? ""),
    platform: String(raw.platform ?? ""),
    syncTrusted: Boolean(raw.syncTrusted ?? raw.sync_trusted),
  }));
}

/**
 * 新设备向 omniserver 请求团队同步密钥；在线设备中继成功后写入本机 Vault。
 */
export async function requestTeamSyncKeyFromRelay(
  opts: RequestTeamSyncKeyOptions,
): Promise<{ fingerprint: string }> {
  const teamId = opts.teamId ?? getCurrentSyncTeamId();
  if (!teamId || teamId <= 0) {
    throw new Error("无法解析当前同步团队");
  }

  const eph = await unwrapCommand(commands.syncTeamKeyGenerateEphemeralKeypair());
  const res = await authFetch(opts.token, "/api/sync/key/request", {
    method: "POST",
    deviceId: opts.deviceId,
    body: JSON.stringify({
      teamId,
      ephemeralPubkey: eph.publicKeyB64,
      wrapAlg: eph.wrapAlg,
    }),
  });

  const payload = (await res.json().catch(() => ({}))) as {
    code?: string;
    requestId?: string;
    wrappedKey?: string;
    error?: string;
    status?: string;
  };

  if (!res.ok) {
    const code = (payload.code ?? "").toLowerCase();
    if (code === "no_online_peer" || res.status === 409) {
      throw new SyncKeyRelayError(
        "no_online_peer",
        "当前无其他在线设备可传递同步密钥，请导入 `.omnipanel-sync.key` 文件",
      );
    }
    if (res.status === 404 || res.status === 501) {
      throw new SyncKeyRelayError(
        "request_failed",
        "服务端尚未支持同步密钥中继，请从其他设备导出密钥文件后导入",
      );
    }
    throw new SyncKeyRelayError(
      "request_failed",
      payload.error?.trim() || `请求同步密钥失败 (${res.status})`,
    );
  }

  if (payload.wrappedKey && payload.requestId) {
    return unwrapFromRelay({
      teamId,
      requestId: payload.requestId,
      wrappedB64: payload.wrappedKey,
      ephemeralSecretB64: eph.secretKeyB64,
      requesterDeviceId: opts.deviceId,
    });
  }

  const requestId = payload.requestId?.trim();
  if (!requestId) {
    throw new SyncKeyRelayError("request_failed", "服务端未返回 requestId");
  }

  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  while (Date.now() < deadline) {
    await sleep(2000);
    const poll = await authFetch(
      opts.token,
      `/api/sync/key/poll?requestId=${encodeURIComponent(requestId)}`,
      { method: "GET", deviceId: opts.deviceId },
    );
    const body = (await poll.json().catch(() => ({}))) as {
      code?: string;
      status?: string;
      wrappedKey?: string;
      error?: string;
    };
    if (body.status === "cancelled" || body.code === "expired") {
      throw new SyncKeyRelayError("request_failed", "同步密钥请求已取消或过期");
    }
    if (body.wrappedKey) {
      return unwrapFromRelay({
        teamId,
        requestId,
        wrappedB64: body.wrappedKey,
        ephemeralSecretB64: eph.secretKeyB64,
        requesterDeviceId: opts.deviceId,
      });
    }
  }

  throw new SyncKeyRelayError("timeout", "等待其他设备传递同步密钥超时");
}

async function unwrapFromRelay(args: {
  teamId: number;
  requestId: string;
  wrappedB64: string;
  ephemeralSecretB64: string;
  requesterDeviceId: string;
}): Promise<{ fingerprint: string }> {
  const out = await unwrapCommand(
    commands.syncTeamKeyUnwrapFromRelay(
      args.teamId,
      args.wrappedB64,
      args.ephemeralSecretB64,
      args.requestId,
      args.requesterDeviceId,
    ),
  );
  return { fingerprint: out.fingerprint };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { importSyncTeamKeyFile };
