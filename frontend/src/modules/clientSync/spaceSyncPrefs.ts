/** 这台电脑的空间同步偏好。不进仓库，换一台电脑各自记。 */

export type SpaceSyncCatchup = "off" | "15m" | "1h";

export type SpaceSyncPrefs = {
  /** 本机改动后自动和云端合并。关掉后只剩手动「立即同步」。 */
  auto: boolean;
  /** 隔一段时间再和云端仓库对齐，收下已经在云端的修改。 */
  catchup: SpaceSyncCatchup;
};

const PREFS_KEY = "omnipanel.spaceSync.v1";
const LAST_KEY = "omnipanel.spaceSync.lastAt";

const listeners = new Set<() => void>();

function normalize(parsed: Partial<SpaceSyncPrefs>): SpaceSyncPrefs {
  const catchup: SpaceSyncCatchup =
    parsed.catchup === "15m" || parsed.catchup === "1h" ? parsed.catchup : "off";
  return {
    auto: parsed.auto !== false,
    catchup,
  };
}

function readJson(): Partial<SpaceSyncPrefs> {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<SpaceSyncPrefs>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

let cachedPrefs: SpaceSyncPrefs = normalize(
  typeof localStorage === "undefined" ? {} : readJson(),
);

export function getSpaceSyncPrefs(): SpaceSyncPrefs {
  return cachedPrefs;
}

export function spaceSyncAutoEnabled(): boolean {
  return getSpaceSyncPrefs().auto;
}

export function setSpaceSyncPrefs(patch: Partial<SpaceSyncPrefs>): SpaceSyncPrefs {
  const next = normalize({ ...cachedPrefs, ...patch });
  cachedPrefs = next;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {
    /* 偏好写不进去时，这次会话仍用内存里的选择 */
  }
  for (const listener of listeners) listener();
  return next;
}

export function spaceSyncLastAt(): number | null {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function noteSpaceSyncFinished(): void {
  try {
    localStorage.setItem(LAST_KEY, String(Date.now()));
  } catch {
    /* 记不住上次时间不影响同步本身 */
  }
  for (const listener of listeners) listener();
}

export function subscribeSpaceSyncPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
