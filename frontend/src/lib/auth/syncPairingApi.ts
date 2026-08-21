/**
 * Sync 设备配对 / 信任 API（经 Tauri auth 代理到 omniserver）。
 * 若对应 IPC 尚未生成，则回退到直连 AUTH 基址（开发用）。
 */
import { commands } from "../../ipc/bindings";
import { unwrapCommand, type CommandResult } from "../../ipc/result";

const AUTH_ASSET_BASE = "https://mp.99.protected.fun";

async function authFetch(
  token: string,
  path: string,
  init?: RequestInit & { appId?: string; deviceId?: string },
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("X-App-Id", init?.appId ?? "omni-client");
  if (init?.deviceId) headers.set("X-Device-Id", init.deviceId);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${AUTH_ASSET_BASE}${path}`, { ...init, headers });
}

export async function trustSyncDevice(token: string, deviceId?: string): Promise<void> {
  const id = deviceId ?? (await resolveDeviceId());
  const anyCommands = commands as Record<string, unknown>;
  if (typeof anyCommands.authSyncDeviceTrust === "function") {
    await unwrapCommand(
      (anyCommands.authSyncDeviceTrust as (
        t: string,
      ) => Promise<CommandResult<unknown>>)(token),
    );
    return;
  }
  const res = await authFetch(token, "/api/sync/device/trust", {
    method: "POST",
    deviceId: id,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `trust failed: ${res.status}`);
  }
}

/** 服务端重置设备同步认证状态：POST /api/sync/device/reset */
export async function resetSyncDevice(token: string, deviceId?: string): Promise<void> {
  const id = deviceId ?? (await resolveDeviceId());
  const anyCommands = commands as Record<string, unknown>;
  if (typeof anyCommands.authSyncDeviceReset === "function") {
    await unwrapCommand(
      (anyCommands.authSyncDeviceReset as (
        t: string,
      ) => Promise<CommandResult<unknown>>)(token),
    );
    return;
  }
  const res = await authFetch(token, "/api/sync/device/reset", {
    method: "POST",
    deviceId: id,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `reset failed: ${res.status}`);
  }
}

async function resolveDeviceId(): Promise<string> {
  try {
    const identity = await unwrapCommand(commands.authDeviceIdentity());
    return identity.deviceId;
  } catch {
    return "omni-client-unknown";
  }
}

export async function fetchSyncDeviceStatus(
  token: string,
): Promise<{ sync_trusted: boolean }> {
  const res = await authFetch(token, "/api/sync/device/status", {
    deviceId: await resolveDeviceId(),
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

export async function pairingStart(
  token: string,
  body: {
    pubkey: string;
    client_nonce: string;
    device_name?: string;
    platform?: string;
  },
): Promise<{
  pairing_id: string;
  verification_code: string;
  expires_at: string;
  expires_in_sec?: number;
}> {
  const res = await authFetch(token, "/api/sync/pairing/start", {
    method: "POST",
    body: JSON.stringify(body),
    deviceId: await resolveDeviceId(),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function pairingGet(
  token: string,
  pairingId: string,
): Promise<{
  pairing_id: string;
  status: string;
  wrapped_key?: string;
  wrap_alg?: string;
  requester_device_id?: string;
  requester_pubkey?: string;
  verification_code?: string;
  device_name?: string;
  platform?: string;
  expires_at?: string;
}> {
  const res = await authFetch(token, `/api/sync/pairing/${encodeURIComponent(pairingId)}`, {
    deviceId: await resolveDeviceId(),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function pairingReject(token: string, pairingId: string): Promise<void> {
  const res = await authFetch(
    token,
    `/api/sync/pairing/${encodeURIComponent(pairingId)}/reject`,
    {
      method: "POST",
      deviceId: await resolveDeviceId(),
    },
  );
  if (!res.ok) throw new Error(await res.text());
}

export async function pairingWrap(
  token: string,
  body: { pairing_id: string; wrapped_key: string; wrap_alg: string },
): Promise<void> {
  const res = await authFetch(token, "/api/sync/pairing/wrap", {
    method: "POST",
    body: JSON.stringify(body),
    deviceId: await resolveDeviceId(),
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function pairingPending(
  token: string,
): Promise<
  Array<{
    pairing_id: string;
    requester_device_id: string;
    requester_pubkey: string;
    created_at: string;
    verification_code?: string;
    device_name?: string;
  }>
> {
  const res = await authFetch(token, "/api/sync/pairing/pending", {
    deviceId: await resolveDeviceId(),
  });
  if (!res.ok) {
    if (res.status === 404) return [];
    throw new Error(await res.text());
  }
  const data = await res.json();
  return Array.isArray(data?.items) ? data.items : [];
}
