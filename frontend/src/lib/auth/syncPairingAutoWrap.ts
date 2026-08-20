/**
 * 主设备：本机已有 SyncMasterKey 时，自动对 pending 配对执行 wrap 传钥。
 * 小程序/动态码授权完成后无需再点「批准并传钥」。
 */
import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { pairingPending, pairingWrap } from "./syncPairingApi";

const INTERVAL_MS = 4_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;
let getToken: (() => string | null) | null = null;
/** 正在处理或刚成功的 pairing_id，避免并发重复 wrap */
const inFlight = new Set<string>();

async function hasLocalSyncMasterKey(): Promise<boolean> {
  try {
    const status = await unwrapCommand(commands.syncMasterKeyStatus());
    return Boolean(status.hasKey && status.key);
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
  } finally {
    // 成功后保留一段时间，失败则稍后允许重试
    window.setTimeout(() => inFlight.delete(id), 30_000);
  }
}

async function tick(gen: number) {
  if (gen !== generation) return;
  const token = getToken?.()?.trim() || null;
  if (!token) return;
  if (!(await hasLocalSyncMasterKey())) return;
  if (gen !== generation) return;

  let items: Awaited<ReturnType<typeof pairingPending>> = [];
  try {
    items = await pairingPending(token);
  } catch {
    return;
  }
  if (gen !== generation || !items.length) return;

  for (const item of items) {
    if (gen !== generation) return;
    try {
      await wrapOne(token, item);
    } catch {
      /* 单条失败不阻断其它；下轮再试 */
      inFlight.delete(item.pairing_id);
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
}
