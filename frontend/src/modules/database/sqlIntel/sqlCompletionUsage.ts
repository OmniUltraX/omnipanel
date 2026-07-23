const STORAGE_KEY = "omnipanel-sql-completion-usage.v1";
const MAX_ENTRIES = 500;
/** 每次使用累加的 boost，用于同类型补全项排序 */
export const SQL_COMPLETION_USAGE_BOOST_STEP = 120;

type UsageStore = Record<string, number>;

function usageKey(kind: number, label: string): string {
  return `${kind}:${label.toLowerCase()}`;
}

// ── 内存缓存 + 延迟合流写入 ──────────────────────────────────────
// 补全列表排序时会对每个候选项调用 getSqlCompletionUsageBoost，
// 原实现每次都全量 JSON.parse(localStorage.getItem)，N 项候选项 = N 次完整读。
// 改为：首次访问懒加载到内存，后续读走内存（O(1)）；
// 写操作立即更新内存，延迟到空闲帧再合流写入 localStorage。
let memoryStore: UsageStore | null = null;
let writeScheduled = false;

function loadFromLocalStorage(): UsageStore {
  if (typeof localStorage === "undefined") {
    return {};
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as UsageStore;
  } catch {
    return {};
  }
}

function getStore(): UsageStore {
  if (memoryStore === null) {
    memoryStore = loadFromLocalStorage();
  }
  return memoryStore;
}

function scheduleFlush(): void {
  if (writeScheduled || typeof localStorage === "undefined") return;
  writeScheduled = true;
  const flush = () => {
    writeScheduled = false;
    if (memoryStore === null) return;
    const entries = Object.entries(memoryStore);
    let toWrite: UsageStore = memoryStore;
    if (entries.length > MAX_ENTRIES) {
      entries.sort((a, b) => b[1] - a[1]);
      toWrite = Object.fromEntries(entries.slice(0, MAX_ENTRIES));
      memoryStore = toWrite;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toWrite));
    } catch {
      // quota / private mode
    }
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(flush, { timeout: 2000 });
  } else {
    setTimeout(flush, 16);
  }
}

export function getSqlCompletionUsageBoost(kind: number, label: string): number {
  const count = getStore()[usageKey(kind, label)] ?? 0;
  return count * SQL_COMPLETION_USAGE_BOOST_STEP;
}

export function recordSqlCompletionUsage(kind: number, label: string): void {
  const key = usageKey(kind, label);
  const store = getStore();
  store[key] = (store[key] ?? 0) + 1;
  scheduleFlush();
}

/** 测试专用：清空本地使用频率缓存 */
export function resetSqlCompletionUsageForTests(): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  memoryStore = {};
  writeScheduled = false;
  localStorage.removeItem(STORAGE_KEY);
}
