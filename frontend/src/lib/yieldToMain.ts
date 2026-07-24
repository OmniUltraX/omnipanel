/**
 * 让出主线程，使 pointer/hover/paint 有机会先执行。
 * 优先 scheduler.yield；否则 MessageChannel（比 setTimeout(0) 更早回到事件循环）。
 */
export function yieldToMain(): Promise<void> {
  const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof sched?.yield === "function") {
    return sched.yield();
  }
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  });
}

/**
 * 至少两帧后再跑（保证骨架/侧栏先 paint），并尽量等 idle。
 * timeoutMs：idle 最迟多久必须挂上重组件。
 */
export function afterPaintIdle(run: () => void, timeoutMs = 64): () => void {
  let cancelled = false;
  let idleId: number | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let raf1 = 0;
  let raf2 = 0;

  const finish = () => {
    if (cancelled) return;
    cancelled = true;
    run();
  };

  raf1 = requestAnimationFrame(() => {
    raf2 = requestAnimationFrame(() => {
      if (cancelled) return;
      if (typeof requestIdleCallback === "function") {
        idleId = requestIdleCallback(finish, { timeout: timeoutMs });
      } else {
        timeoutId = setTimeout(finish, 0);
      }
    });
  });

  return () => {
    cancelled = true;
    if (raf1) cancelAnimationFrame(raf1);
    if (raf2) cancelAnimationFrame(raf2);
    if (idleId != null && typeof cancelIdleCallback === "function") {
      cancelIdleCallback(idleId);
    }
    if (timeoutId != null) clearTimeout(timeoutId);
  };
}
