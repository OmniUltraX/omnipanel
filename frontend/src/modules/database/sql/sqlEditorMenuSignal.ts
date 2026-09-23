export type SqlEditorMenuSignal = { key: string; x: number; y: number };

let signal: SqlEditorMenuSignal | null = null;
let openedAt = 0;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

export function openSqlEditorMenu(next: SqlEditorMenuSignal) {
  signal = next;
  openedAt = Date.now();
  emit();
}

export function closeSqlEditorMenu() {
  if (!signal) return;
  // 右键按下会紧跟着一次 mousedown/click，忽略打开后的这一下，否则菜单会瞬间关掉。
  if (Date.now() - openedAt < 280) return;
  signal = null;
  emit();
}

export function subscribeSqlEditorMenu(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSqlEditorMenu() {
  return signal;
}
