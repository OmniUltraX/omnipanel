import type { SbaJvmSnapshot } from "../../../../ipc/bindings";
import { SPRING_BOOT_ADMIN_HISTORY_MAX } from "./layout";

export type SbaSample = {
  t: number;
  threadsLive: number | null;
  threadsDaemon: number | null;
  threadsPeak: number | null;
  heapUsed: number | null;
  heapCommitted: number | null;
  nonHeapUsed: number | null;
  nonHeapCommitted: number | null;
  nonHeapInit: number | null;
};

const histories = new Map<string, SbaSample[]>();

export function sbaHistoryKey(adminUrl: string, instanceId: string): string {
  return `${adminUrl.trim()}|${instanceId.trim()}`;
}

export function sampleToSnapshot(sample: SbaSample): SbaJvmSnapshot {
  return {
    threadsLive: sample.threadsLive,
    threadsDaemon: sample.threadsDaemon,
    threadsPeak: sample.threadsPeak,
    heapUsed: sample.heapUsed,
    heapCommitted: sample.heapCommitted,
    heapMax: null,
    nonHeapUsed: sample.nonHeapUsed,
    nonHeapCommitted: sample.nonHeapCommitted,
    nonHeapMax: null,
    nonHeapInit: sample.nonHeapInit,
  };
}

export function snapshotToSample(snapshot: SbaJvmSnapshot, t = Date.now()): SbaSample {
  return {
    t,
    threadsLive: snapshot.threadsLive,
    threadsDaemon: snapshot.threadsDaemon,
    threadsPeak: snapshot.threadsPeak,
    heapUsed: snapshot.heapUsed,
    heapCommitted: snapshot.heapCommitted,
    nonHeapUsed: snapshot.nonHeapUsed,
    nonHeapCommitted: snapshot.nonHeapCommitted,
    nonHeapInit: snapshot.nonHeapInit,
  };
}

export function pushSbaSample(key: string, sample: SbaSample): SbaSample[] {
  const prev = histories.get(key) ?? [];
  const next = [...prev, sample].slice(-SPRING_BOOT_ADMIN_HISTORY_MAX);
  histories.set(key, next);
  return next;
}

export function getSbaHistory(key: string): SbaSample[] {
  return histories.get(key) ?? [];
}

/** 空值沿用上一次有效采样，避免折线断开 */
export function seriesValues(
  samples: SbaSample[],
  pick: (sample: SbaSample) => number | null,
): number[] {
  const out: number[] = [];
  let last: number | null = null;
  for (const sample of samples) {
    const value = pick(sample);
    if (value != null && Number.isFinite(value) && value >= 0) {
      last = value;
    }
    if (last != null) out.push(last);
  }
  return out;
}
