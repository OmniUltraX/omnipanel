/**
 * 主设备：本机已有 SyncMasterKey 时，自动对 pending 配对执行 wrap 传钥。
 * 小程序扫码授权完成后无需再点「批准并传钥」。
 */
import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { pairingPending, pairingWrap, trustSyncDevice } from "./syncPairingApi";

const INTERVAL_MS = 4_000;
/** 失败 toast 节流 */
const FAIL_TOAST_COOLDOWN_MS = 20_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;
let getToken: (() => string | null) | null = null;
/** 正在处理或刚成功的 pairing_id，避免并发重复 wrap */
const inFlight = new Set<string>();
let lastFailToastAt = 0;
let ensuredTrust = false;

function reportFail(message: string) {
  const now = Date.now();
  if (now - lastFailToastAt < FAIL_TOAST_COOLDOWN_MS) {
    console.warn("[syncPairingAutoWrap]", message);
    return;
  }
  lastFailToastAt = now;
  console.warn("[syncPairingAutoWrap]", message);
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
    // 非致命：服务端已放宽 pending/wrap 的 trust 门闸
    console.warn("[syncPairingAutoWrap] trustSyncDevice failed", e);
  }
}

async function ensureLocalMasterKeyForWrap(): Promise<boolean> {
  try {
    const status = await unwrapCommand(commands.syncMasterKeyStatus());
    if (status.hasKey) return true;
    await unwrapCommand(commands.syncMasterKeyGetOrCreate());
    void import("../../modules/clientSync")
      .then(({ scheduleSecretsVaultSync }) => scheduleSecretsVaultSync())
      .catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

async function wrapOne(
  token: string,
  item: {
    pairing_id: string;
    requester_device_id: string;
    requester_pubkey: string;
  },
): Promise<void> {
  const id = item.pairing_id;
  if (!id || inFlight.has(id)) return;
  inFlight.add(id);
  try {
    if (!(await ensureLocalMasterKeyForWrap())) {
      reportFail("自动传钥失败：本机尚无同步主密钥");
      return;
    }
    const wrapped = await unwrapCommand(
      commands.syncPairingWrapKey({
        pairingId: item.pairing_id,
        requesterDeviceId: item.requester_device_id,
        requesterPubkeyB64: item.requester_pubkey,
      }),
    );
    await pairingWrap(token, {
      pairing_id: item.pairing_id,
      wrapped_key: wrapped.wrappedKey,
      wrap_alg: wrapped.wrapAlg,
    });
    void import("../../stores/toastStore")
      .then(({ showToast }) => showToast("已自动向新设备传钥"))
      .catch(() => undefined);
  } finally {
    window.setTimeout(() => inFlight.delete(id), 30_000);
  }
}

async function tick(gen: number) {
  if (gen !== generation) return;
  const token = getToken?.()?.trim() || null;
  if (!token) return;
  if (gen !== generation) return;

  await ensureSelfTrusted(token);
  if (gen !== generation) return;

  let items: Awaited<ReturnType<typeof pairingPending>> = [];
  try {
    items = await pairingPending(token);
  } catch (e) {
    reportFail(
      e instanceof Error
        ? `自动传钥：拉取待配对失败（${e.message}）`
        : "自动传钥：拉取待配对失败",
    );
    return;
  }
  if (gen !== generation || !items.length) return;

  for (const item of items) {
    if (gen !== generation) return;
    try {
      await wrapOne(token, item);
    } catch (e) {
      inFlight.delete(item.pairing_id);
      reportFail(
        e instanceof Error
          ? `自动传钥失败：${e.message}`
          : "自动传钥失败，请在设备页点「立即重试」",
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

export function startSyncPairingAutoWrap(opts: { getToken: () => string | null }) {
  stopSyncPairingAutoWrap();
  getToken = opts.getToken;
  const token = getToken()?.trim() || null;
  if (!token) return;
  const gen = ++generation;
  void (async () => {
    await tick(gen);
    scheduleNext(gen);
  })();
}

export function stopSyncPairingAutoWrap() {
  generation += 1;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  getToken = null;
  inFlight.clear();
  ensuredTrust = false;
}
