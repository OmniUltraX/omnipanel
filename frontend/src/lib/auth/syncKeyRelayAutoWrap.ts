/**
 * 持钥设备的 HTTP 传钥兜底。
 *
 * mesh TCP 仍是主路径。这里只处理已经落到服务端的中继请求：
 * 本机没有团队同步密钥时不启动；有密钥时听 `client.sync.key.relay.pending`，
 * 通知流断开才按分钟级补拉 pending。
 */
import type { UnlistenFn } from "@tauri-apps/api/event";
import { listen } from "@tauri-apps/api/event";
import { commands } from "../../ipc/bindings";
import { SYNC_KEY_RELAY_CHANNEL, SYNC_KEY_RELAY_PENDING } from "../../ipc/events";
import { unwrapCommand } from "../../ipc/result";
import { safeTauriUnlisten } from "../safeTauriUnlisten";
import { isTauriRuntime } from "../isTauriRuntime";
import { getCurrentSyncTeamId } from "../../stores/currentSyncTeamStore";
import { useUserProfileStore } from "../../stores/userProfileStore";
import { bindSyncKeyRelayDonorRefresh } from "./syncKeyRelayDonorBridge";
import { isRelayTransportError, nextRelayFallbackDelayMs } from "./syncKeyRelayDonorPolicy";
import { getSyncTeamKeyStatus } from "./syncTeamKeyApi";
import {
  listPendingKeyRelays,
  relayTeamSyncKey,
  type PendingKeyRelayItem,
} from "./syncKeyRelayApi";

const WARN_COOLDOWN_MS = 60_000;

let generation = 0;
let evalSeq = 0;
let getToken: (() => string | null) | null = null;
let unsubProfile: (() => void) | null = null;
let unlistenPending: UnlistenFn | null = null;
let unlistenChannel: UnlistenFn | null = null;
let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
let donorActive = false;
let channelUp = false;
let sseToken: string | null = null;
let failureStreak = 0;
let listInFlight = false;
let lastWarnAt = 0;
const inFlight = new Set<string>();

function warnOnce(message: string) {
  const now = Date.now();
  if (now - lastWarnAt < WARN_COOLDOWN_MS) return;
  lastWarnAt = now;
  console.warn("[syncKeyRelayAutoWrap]", message);
}

function clearFallback() {
  if (fallbackTimer) {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }
}

function teamIdsToCheck(): number[] {
  const ids = new Set<number>();
  const current = getCurrentSyncTeamId();
  if (current && current > 0) ids.add(current);
  for (const team of useUserProfileStore.getState().teams) {
    if (typeof team.id === "number" && team.id > 0) ids.add(team.id);
  }
  return [...ids];
}

async function hasAnyLocalTeamKey(): Promise<boolean> {
  const ids = teamIdsToCheck();
  if (!ids.length) return false;
  const flags = await Promise.all(
    ids.map(async (id) => {
      try {
        const status = await getSyncTeamKeyStatus(id);
        return status.hasKey;
      } catch {
        return false;
      }
    }),
  );
  return flags.some(Boolean);
}

async function ensureLocalTeamKey(teamId: number): Promise<boolean> {
  try {
    const status = await getSyncTeamKeyStatus(teamId);
    return status.hasKey;
  } catch {
    return false;
  }
}

async function relayOne(token: string, item: PendingKeyRelayItem): Promise<void> {
  const id = item.requestId;
  if (!id || inFlight.has(id)) return;
  inFlight.add(id);
  try {
    if (!(await ensureLocalTeamKey(item.teamId))) return;
    const wrapped = await unwrapCommand(
      commands.syncTeamKeyWrapForRelay(
        item.teamId,
        item.ephemeralPubkey,
        item.requestId,
        item.requesterDeviceId,
      ),
      { quiet: true },
    );
    await relayTeamSyncKey(token, {
      requestId: item.requestId,
      wrappedKey: wrapped,
      wrapAlg: item.wrapAlg,
    }, { quiet: true });
    void import("../../stores/toastStore")
      .then(({ showToast }) => showToast("已自动向组织内新设备传递团队同步密钥"))
      .catch(() => undefined);
  } finally {
    window.setTimeout(() => inFlight.delete(id), 30_000);
  }
}

function pendingFromEvent(payload: {
  requestId?: string;
  teamId?: number;
  requesterDeviceId?: string;
  ephemeralPubkey?: string;
  wrapAlg?: string;
}): PendingKeyRelayItem | null {
  const requestId = payload.requestId?.trim() ?? "";
  const teamId = Number(payload.teamId);
  const ephemeralPubkey = payload.ephemeralPubkey?.trim() ?? "";
  if (!requestId || !Number.isFinite(teamId) || teamId <= 0 || !ephemeralPubkey) return null;
  return {
    requestId,
    teamId,
    requesterDeviceId: payload.requesterDeviceId?.trim() ?? "",
    ephemeralPubkey,
    wrapAlg: payload.wrapAlg,
  };
}

async function pullPending(gen: number, token: string): Promise<void> {
  if (listInFlight || gen !== generation) return;
  listInFlight = true;
  try {
    const items = await listPendingKeyRelays(token, { quiet: true });
    if (gen !== generation) return;
    failureStreak = 0;
    for (const item of items) {
      if (gen !== generation) return;
      try {
        await relayOne(token, item);
      } catch (e) {
        inFlight.delete(item.requestId);
        if (!isRelayTransportError(e)) {
          warnOnce(e instanceof Error ? `自动传钥失败：${e.message}` : "自动传钥失败");
        }
      }
    }
  } catch (e) {
    if (isRelayTransportError(e)) {
      failureStreak += 1;
      return;
    }
    warnOnce(
      e instanceof Error ? `自动传钥：拉取待中继请求失败（${e.message}）` : "自动传钥：拉取待中继请求失败",
    );
  } finally {
    listInFlight = false;
  }
}

function scheduleFallback(gen: number) {
  clearFallback();
  if (gen !== generation || !donorActive || channelUp) return;
  const token = getToken?.()?.trim() || "";
  if (!token) return;
  fallbackTimer = setTimeout(() => {
    fallbackTimer = null;
    void (async () => {
      if (gen !== generation || !donorActive || channelUp) return;
      const next = getToken?.()?.trim() || "";
      if (!next) return;
      await pullPending(gen, next);
      scheduleFallback(gen);
    })();
  }, nextRelayFallbackDelayMs(failureStreak));
}

function detachListeners() {
  safeTauriUnlisten(unlistenPending);
  safeTauriUnlisten(unlistenChannel);
  unlistenPending = null;
  unlistenChannel = null;
}

function resetLoopState() {
  generation += 1;
  evalSeq += 1;
  donorActive = false;
  channelUp = false;
  sseToken = null;
  failureStreak = 0;
  inFlight.clear();
  clearFallback();
  detachListeners();
}

let channelQueue: Promise<void> = Promise.resolve();

function enqueueChannel(task: () => Promise<void>): Promise<void> {
  channelQueue = channelQueue.then(task, task);
  return channelQueue;
}

async function stopChannel() {
  await enqueueChannel(async () => {
    if (!isTauriRuntime() || typeof commands.syncKeyRelayInboxStop !== "function") return;
    await unwrapCommand(commands.syncKeyRelayInboxStop(), { quiet: true }).catch(() => undefined);
  });
}

async function startChannel(gen: number, token: string) {
  if (!isTauriRuntime() || typeof commands.syncKeyRelayInboxStart !== "function") {
    channelUp = false;
    return;
  }
  detachListeners();
  unlistenPending = await listen<{
    requestId?: string;
    teamId?: number;
    requesterDeviceId?: string;
    ephemeralPubkey?: string;
    wrapAlg?: string;
  }>(SYNC_KEY_RELAY_PENDING, (event) => {
    if (gen !== generation || !donorActive) return;
    const item = pendingFromEvent(event.payload ?? {});
    const current = getToken?.()?.trim() || "";
    if (!item || !current) return;
    void relayOne(current, item).catch((e) => {
      inFlight.delete(item.requestId);
      if (!isRelayTransportError(e)) {
        warnOnce(e instanceof Error ? `自动传钥失败：${e.message}` : "自动传钥失败");
      }
    });
  });
  unlistenChannel = await listen<{ up?: boolean }>(SYNC_KEY_RELAY_CHANNEL, (event) => {
    if (gen !== generation || !donorActive) return;
    channelUp = event.payload?.up === true;
    if (channelUp) {
      clearFallback();
      return;
    }
    scheduleFallback(gen);
  });
  await enqueueChannel(async () => {
    if (gen !== generation) return;
    try {
      await unwrapCommand(commands.syncKeyRelayInboxStart(token), { quiet: true });
      if (gen !== generation) return;
      sseToken = token;
    } catch (e) {
      channelUp = false;
      if (!isRelayTransportError(e)) {
        warnOnce(
          e instanceof Error ? `自动传钥通道启动失败：${e.message}` : "自动传钥通道启动失败",
        );
      }
    }
  });
  if (gen !== generation) {
    detachListeners();
    await stopChannel();
  }
}

async function evaluate() {
  const gen = generation;
  const seq = ++evalSeq;
  const token = getToken?.()?.trim() || "";
  if (!token) {
    resetLoopState();
    await stopChannel();
    return;
  }
  const held = await hasAnyLocalTeamKey();
  if (gen !== generation || seq !== evalSeq) return;
  if (!held) {
    donorActive = false;
    channelUp = false;
    sseToken = null;
    clearFallback();
    detachListeners();
    generation += 1;
    await stopChannel();
    return;
  }
  if (donorActive && sseToken === token) return;
  donorActive = true;
  channelUp = false;
  await startChannel(gen, token);
  if (gen !== generation || seq !== evalSeq) return;
  await pullPending(gen, token);
  if (gen !== generation || seq !== evalSeq) return;
  if (!channelUp) scheduleFallback(gen);
}

export function startSyncKeyRelayAutoWrap(opts: { getToken: () => string | null }) {
  resetLoopState();
  bindSyncKeyRelayDonorRefresh(null);
  if (unsubProfile) {
    unsubProfile();
    unsubProfile = null;
  }
  getToken = opts.getToken;
  bindSyncKeyRelayDonorRefresh(() => {
    void evaluate();
  });
  unsubProfile = useUserProfileStore.subscribe((state, prev) => {
    if (state.teams === prev.teams) return;
    void evaluate();
  });
  void evaluate();
}

export function stopSyncKeyRelayAutoWrap() {
  resetLoopState();
  bindSyncKeyRelayDonorRefresh(null);
  if (unsubProfile) {
    unsubProfile();
    unsubProfile = null;
  }
  getToken = null;
  void stopChannel();
}
