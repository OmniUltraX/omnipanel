/**
 * 叠层切换时，在新模块真正提交内容前继续显示上一个已就绪模块，
 * 避免 Suspense 回退把「加载中…」或空白闪到内容区。
 */

const readyIds = new Set<string>();
const listeners = new Set<() => void>();

let targetId: string | null = null;
let visualId: string | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

function recompute(): void {
  if (!targetId) {
    visualId = null;
    return;
  }
  if (readyIds.has(targetId)) {
    visualId = targetId;
    return;
  }
  if (visualId && readyIds.has(visualId)) {
    return;
  }
  visualId = targetId;
}

export function resetOverlayRevealForTests(): void {
  readyIds.clear();
  targetId = null;
  visualId = null;
}

export function setOverlayRevealTarget(id: string | null): void {
  if (targetId === id) {
    recompute();
    return;
  }
  targetId = id;
  recompute();
  emit();
}

export function markOverlayContentReady(id: string): void {
  if (!id) return;
  const already = readyIds.has(id);
  readyIds.add(id);
  const prevVisual = visualId;
  recompute();
  if (!already || prevVisual !== visualId) emit();
}

export function forgetOverlayContentReady(id: string): void {
  if (!readyIds.delete(id)) return;
  if (visualId === id && targetId !== id) {
    visualId = targetId;
  }
  recompute();
  emit();
}

export function getOverlayRevealTarget(): string | null {
  return targetId;
}

export function isOverlayVisuallyActive(id: string): boolean {
  if (!targetId) return false;
  if (readyIds.has(targetId)) return id === targetId;
  if (visualId) return id === visualId;
  return id === targetId;
}

export function subscribeOverlayReveal(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
