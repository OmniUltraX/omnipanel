/**
 * 在线设备：自动对 pending 团队同步密钥中继请求执行 wrap + relay。
 */
import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import {
  listPendingKeyRelays,
  relayTeamSyncKey,
  type PendingKeyRelayItem,
} from "./syncKeyRelayApi";
import { trustSyncDevice } from "./syncPairingApi";

const INTERVAL_MS = 4_000;
const FAIL_TOAST_COOLDOWN_MS = 20_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;
let getToken: (() => string | null) | null = null;
const inFlight = new Set<string>();
let lastFailToastAt = 0;
let ensuredTrust = false;

function reportFail(message: string) {
  const now = Date.now();
  if (now - lastFailToastAt < FAIL_TOAST_COOLDOWN_MS) {
    console.warn("[syncKeyRelayAutoWrap]", message);
    return;
  }
  lastFailToastAt = now;
  console.warn("[syncKeyRelayAutoWrap]", message);
  void import("../../stores/toastStore")
    .then(({ showToast }) => {
      showToast(message.slice(0, 120));
    })
    .catch(() => undefined);
}

async function ensureSelfTrusted(token: string) {
  if (ensuredTrust) return;
  try {
    await trustSyncDevice(token);
    ensuredTrust = true;
  } catch (e) {
    console.warn("[syncKeyRelayAutoWrap] trustSyncDevice failed", e);
  }
}

async function ensureLocalTeamKey(teamId: number): Promise<boolean> {
  try {
    const status = await unwrapCommand(commands.syncTeamKeyStatus(teamId), { quiet: true });
    if (status.hasKey) return true;
    return false;
  } catch {
    return false;
  }
}

async function relayOne(token: string, item: PendingKeyRelayItem): Promise<void> {
  const id = item.requestId;
  if (!id || inFlight.has(id)) return;
  inFlight.add(id);
  try {
    if (!(await ensureLocalTeamKey(item.teamId))) {
      return;
    }
    const wrapped = await unwrapCommand(
      commands.syncTeamKeyWrapForRelay(
        item.teamId,
        item.ephemeralPubkey,
        item.requestId,
        item.requesterDeviceId,
      ),
    );
    await relayTeamSyncKey(token, {
      requestId: item.requestId,
      wrappedKey: wrapped,
      wrapAlg: item.wrapAlg,
    });
    void import("../../stores/toastStore")
      .then(({ showToast }) => showToast("已自动向新设备传递团队同步密钥"))
      .catch(() => undefined);
  } finally {
    window.setTimeout(() => inFlight.delete(id), 30_000);
  }
}

async function tick(gen: number) {
  if (gen !== generation) return;
  const token = getToken?.()?.trim() || null;
  if (!token) return;

  await ensureSelfTrusted(token);
  if (gen !== generation) return;

  let items: PendingKeyRelayItem[] = [];
  try {
    items = await listPendingKeyRelays(token);
  } catch (e) {
    reportFail(
      e instanceof Error
        ? `自动传钥：拉取待中继请求失败（${e.message}）`
        : "自动传钥：拉取待中继请求失败",
    );
    return;
  }
  if (gen !== generation || !items.length) return;

  for (const item of items) {
    if (gen !== generation) return;
    try {
      await relayOne(token, item);
    } catch (e) {
      inFlight.delete(item.requestId);
      reportFail(
        e instanceof Error
          ? `自动传钥失败：${e.message}`
          : "自动传钥失败",
      );
    }
  }
}

function scheduleNext(gen: number) {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (gen !== generation) return;
  timer = setTimeout(() => {
    timer = null;
    void (async () => {
      await tick(gen);
      scheduleNext(gen);
    })();
  }, INTERVAL_MS);
}

export function startSyncKeyRelayAutoWrap(opts: { getToken: () => string | null }) {
  stopSyncKeyRelayAutoWrap();
  getToken = opts.getToken;
  const token = getToken()?.trim() || null;
  if (!token) return;
  const gen = ++generation;
  void (async () => {
    await tick(gen);
    scheduleNext(gen);
  })();
}

export function stopSyncKeyRelayAutoWrap() {
  generation += 1;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  getToken = null;
  inFlight.clear();
  ensuredTrust = false;
}
