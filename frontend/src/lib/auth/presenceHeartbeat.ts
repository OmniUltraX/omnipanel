import { isAuthSessionError, touchPresence } from "./loginApi";

/** 默认心跳间隔：与服务端 PRESENCE_TTL=180s 对齐（约 TTL/3） */
const DEFAULT_INTERVAL_MS = 60 * 1000;

let timer: ReturnType<typeof setTimeout> | null = null;
let intervalMs = DEFAULT_INTERVAL_MS;
let generation = 0;
let getToken: (() => string | null) | null = null;
let onAuthExpired: (() => void) | null = null;

function scheduleNext(gen: number) {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (gen !== generation) return;
  const token = getToken?.()?.trim() || null;
  if (!token) return;

  timer = setTimeout(async () => {
    timer = null;
    if (gen !== generation) return;
    const nextToken = getToken?.()?.trim() || null;
    if (!nextToken) return;
    try {
      const body = await touchPresence(nextToken);
      const ttl = Number(body?.ttlSec);
      if (Number.isFinite(ttl) && ttl > 0) {
        intervalMs = Math.max(15_000, Math.floor((ttl * 1000) / 3));
      }
    } catch (error) {
      if (isAuthSessionError(error)) {
        stopPresenceHeartbeat();
        onAuthExpired?.();
        return;
      }
      /* 网络抖动忽略，下轮再试 */
    }
    scheduleNext(gen);
  }, intervalMs);
}

/**
 * 登录后启动周期心跳；已登录时立即打一次。
 * 间隔默认 60s，可按服务端返回的 ttlSec/3 自适应。
 */
export function startPresenceHeartbeat(opts: {
  getToken: () => string | null;
  onAuthExpired?: () => void;
  intervalMs?: number;
}) {
  stopPresenceHeartbeat();
  getToken = opts.getToken;
  onAuthExpired = opts.onAuthExpired ?? null;

  const token = getToken()?.trim() || null;
  if (!token) return;

  const gen = ++generation;
  const ms = Number(opts.intervalMs);
  if (Number.isFinite(ms) && ms >= 15_000) {
    intervalMs = ms;
  }

  void touchPresence(token)
    .then((body) => {
      if (gen !== generation) return;
      const ttl = Number(body?.ttlSec);
      if (Number.isFinite(ttl) && ttl > 0) {
        intervalMs = Math.max(15_000, Math.floor((ttl * 1000) / 3));
      }
    })
    .catch((error) => {
      if (gen !== generation) return;
      if (isAuthSessionError(error)) {
        stopPresenceHeartbeat();
        onAuthExpired?.();
      }
    })
    .finally(() => {
      if (gen === generation && getToken?.()?.trim()) {
        scheduleNext(gen);
      }
    });
}

export function stopPresenceHeartbeat() {
  generation += 1;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  getToken = null;
  onAuthExpired = null;
  intervalMs = DEFAULT_INTERVAL_MS;
}
