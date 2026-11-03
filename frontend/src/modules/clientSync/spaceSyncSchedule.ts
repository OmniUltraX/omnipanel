/**
 * 定时再和云端仓库对齐一次，收下已经在云端的修改。本机自己的修改不走这里。
 * 间隔太短会和正在进行的仓库同步叠在一起。
 */
import { flushClientModuleSync } from "./moduleSync";
import { getSpaceSyncPrefs, subscribeSpaceSyncPrefs } from "./spaceSyncPrefs";

const CATCHUP_MS: Record<"15m" | "1h", number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
};

let timer: ReturnType<typeof setInterval> | null = null;
let applied = "";

function restart(): void {
  const prefs = getSpaceSyncPrefs();
  const key = `${prefs.auto}:${prefs.catchup}`;
  // 上次同步时间也会通知订阅者。那不是改间隔，不能把计时清零。
  if (key === applied) return;
  applied = key;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (!prefs.auto || prefs.catchup === "off") return;
  timer = setInterval(() => {
    void flushClientModuleSync();
  }, CATCHUP_MS[prefs.catchup]);
}

subscribeSpaceSyncPrefs(restart);
restart();
