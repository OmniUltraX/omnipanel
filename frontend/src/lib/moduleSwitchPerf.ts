/**
 * 模块切换耗时 / 堆内存探针（秒切回 P0 测量用）。
 *
 * 原理：路由变化 effect 里打点，双 rAF 后视为首帧绘制完成，
 * 采集耗时 + `performance.memory.usedJSHeapSize`（Chromium 系可用，
 * 含 Tauri WebView；取不到记 null）。
 *
 * 使用：切换几个模块后在控制台跑
 * `window.__omniSwitchPerf.summary()` 看按路由对聚合（avg/p95/次数），
 * `window.__omniSwitchPerf.samples()` 看原始序列。
 * A/B 对照：localStorage `omnipanel.keepAlive.retainAll` 置 "0" 退回 LRU，
 * 删值（或其它值）恢复全保留，reload 后重走同一遍切换即可对比。
 * 仅 DEV 输出单条日志；生产包静默采集（ring 100 条，内存可忽略）。
 */

export type SwitchSample = {
  from: string;
  to: string;
  /** effect 触发到双 rAF 回调的毫秒数（含 React 提交 + 首帧绘制） */
  ms: number;
  /** 用户输入（pointerdown/Enter）到 effect 触发的毫秒数（导航分发耗时，>3s 视为无关记 null） */
  inputToEffectMs: number | null;
  /** 输入到 layout-effect 的毫秒数（≈ 事件分发 + React render + DOM 落子，不含布局绘制） */
  inputToLayoutMs: number | null;
  /** 绘制完成时的 JS 堆 MB（取不到为 null） */
  heapMB: number | null;
  at: number;
};

const RING_LIMIT = 100;
const ring: SwitchSample[] = [];
let lastInputAt = 0;
let lastLayoutAt = 0;
let pointerListenerArmed = false;

function ensurePointerListener(): void {
  if (pointerListenerArmed || typeof document === "undefined") return;
  pointerListenerArmed = true;
  const mark = () => {
    lastInputAt = performance.now();
  };
  // 捕获期：抢在 React 合成事件之前打点
  document.addEventListener("pointerdown", mark, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") mark();
  }, true);
}

function readHeapMB(): number | null {
  try {
    const mem = (performance as { memory?: { usedJSHeapSize?: number } }).memory;
    const bytes = mem?.usedJSHeapSize;
    if (typeof bytes !== "number" || !Number.isFinite(bytes)) return null;
    return Math.round((bytes / 1048576) * 10) / 10;
  } catch {
    return null;
  }
}

export function recordRouteSwitch(from: string, to: string): void {
  if (from === to) return;
  ensurePointerListener();
  const t0 = performance.now();
  const gap = t0 - lastInputAt;
  const inputToEffectMs = lastInputAt > 0 && gap >= 0 && gap < 3000 ? Math.round(gap * 10) / 10 : null;
  const layoutGap = lastLayoutAt > 0 && t0 >= lastLayoutAt ? t0 - lastLayoutAt : -1;
  const inputToLayoutMs =
    lastInputAt > 0 && lastLayoutAt > lastInputAt && layoutGap >= 0 && layoutGap < 3000
      ? Math.round((lastLayoutAt - lastInputAt) * 10) / 10
      : null;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      ring.push({ from, to, ms: Math.round((performance.now() - t0) * 10) / 10, inputToEffectMs, inputToLayoutMs, heapMB: readHeapMB(), at: Date.now() });
      if (ring.length > RING_LIMIT) ring.splice(0, ring.length - RING_LIMIT);
      if (import.meta.env.DEV) {
        const last = ring[ring.length - 1];
        // eslint-disable-next-line no-console
        console.log(`[switch-perf] ${from} → ${to}: ${last.ms}ms (input→effect ${last.inputToEffectMs ?? "?"}ms), heap ${last.heapMB ?? "?"}MB`);
      }
    });
  });
}

export type SwitchAggregate = {
  pair: string;
  count: number;
  avgMs: number;
  p95Ms: number;
  avgInputToEffectMs: number | null;
  avgInputToLayoutMs: number | null;
  lastHeapMB: number | null;
};

export function switchPerfSummary(): SwitchAggregate[] {
  const groups = new Map<string, SwitchSample[]>();
  for (const s of ring) {
    const key = `${s.from} → ${s.to}`;
    const arr = groups.get(key) ?? [];
    arr.push(s);
    groups.set(key, arr);
  }
  return [...groups.entries()].map(([pair, arr]) => {
    const sorted = arr.map((s) => s.ms).sort((a, b) => a - b);
    const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    const inputs = arr.map((s) => s.inputToEffectMs).filter((v): v is number => v != null);
    const layouts = arr.map((s) => s.inputToLayoutMs).filter((v): v is number => v != null);
    const avgOf = (xs: number[]): number | null =>
      xs.length > 0 ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null;
    return {
      pair,
      count: arr.length,
      avgMs: Math.round(avg * 10) / 10,
      p95Ms: p95,
      avgInputToEffectMs: avgOf(inputs),
      avgInputToLayoutMs: avgOf(layouts),
      lastHeapMB: arr[arr.length - 1].heapMB,
    };
  });
}

export function resetSwitchPerf(): void {
  ring.length = 0;
}

/** Outlet 的 useLayoutEffect 在 pathname 变化时调用：标记 DOM 落子时刻 */
export function noteRouteLayoutCommit(): void {
  lastLayoutAt = performance.now();
}

declare global {
  interface Window {
    __omniSwitchPerf?: {
      samples: () => SwitchSample[];
      summary: () => SwitchAggregate[];
      reset: () => void;
    };
  }
}

if (typeof window !== "undefined" && !window.__omniSwitchPerf) {
  window.__omniSwitchPerf = {
    samples: () => [...ring],
    summary: switchPerfSummary,
    reset: resetSwitchPerf,
  };
}
