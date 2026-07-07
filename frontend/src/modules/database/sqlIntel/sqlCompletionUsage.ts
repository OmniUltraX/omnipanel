const STORAGE_KEY = "omnipanel-sql-completion-usage.v1";
const MAX_ENTRIES = 500;
/** 每次使用累加的 boost，用于同类型补全项排序 */
export const SQL_COMPLETION_USAGE_BOOST_STEP = 120;

type UsageStore = Record<string, number>;

function usageKey(kind: number, label: string): string {
  return `${kind}:${label.toLowerCase()}`;
}

function readStore(): UsageStore {
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

function writeStore(store: UsageStore): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  const entries = Object.entries(store);
  if (entries.length > MAX_ENTRIES) {
    entries.sort((a, b) => b[1] - a[1]);
    store = Object.fromEntries(entries.slice(0, MAX_ENTRIES));
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // quota / private mode
  }
}

export function getSqlCompletionUsageBoost(kind: number, label: string): number {
  const count = readStore()[usageKey(kind, label)] ?? 0;
  return count * SQL_COMPLETION_USAGE_BOOST_STEP;
}

export function recordSqlCompletionUsage(kind: number, label: string): void {
  const key = usageKey(kind, label);
  const store = readStore();
  store[key] = (store[key] ?? 0) + 1;
  writeStore(store);
}

/** 测试专用：清空本地使用频率缓存 */
export function resetSqlCompletionUsageForTests(): void {
  if (typeof localStorage === "undefined") {
    return;
  }
  localStorage.removeItem(STORAGE_KEY);
}
