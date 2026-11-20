import { create } from "zustand";
import { commands, type SpaceConflict } from "../ipc/bindings";
import { unwrapCommand } from "../ipc/result";

interface SpaceConflictState {
  items: SpaceConflict[];
  byPath: Record<string, SpaceConflict>;
  overviewOpen: boolean;
  refresh: () => Promise<void>;
  dismiss: (id: string) => Promise<void>;
  /** 只删冲突记录，当前资源不动。 */
  dismissIds: (ids: string[]) => Promise<void>;
  dismissAll: () => Promise<void>;
  openOverview: () => void;
  closeOverview: () => void;
}

/** 已经弹过的路径。同一批没处理完不再打开；路径消失后可以再报一次。 */
const announcedPaths = new Set<string>();

function overviewFor(items: SpaceConflict[], overviewOpen: boolean): boolean {
  if (items.length === 0) {
    announcedPaths.clear();
    return false;
  }
  const live = new Set(items.map((item) => item.path));
  for (const path of [...announcedPaths]) {
    if (!live.has(path)) announcedPaths.delete(path);
  }
  const fresh = items.some((item) => !announcedPaths.has(item.path));
  for (const item of items) announcedPaths.add(item.path);
  return fresh ? true : overviewOpen;
}

export const useSpaceConflictStore = create<SpaceConflictState>((set, get) => ({
  items: [],
  byPath: {},
  overviewOpen: false,
  refresh: async () => {
    try {
      const list = await unwrapCommand(commands.localSpaceListConflicts(), { quiet: true });
      const byPath: Record<string, SpaceConflict> = {};
      for (const item of list) {
        if (!byPath[item.path]) byPath[item.path] = item;
      }
      const items = Object.values(byPath).sort(
        (a, b) => b.recordedAt - a.recordedAt || a.path.localeCompare(b.path),
      );
      set({
        byPath,
        items,
        overviewOpen: overviewFor(items, get().overviewOpen),
      });
    } catch {
      // 本机库还没打开时不打断界面
    }
  },
  dismiss: async (id) => {
    await get().dismissIds([id]);
  },
  dismissIds: async (ids) => {
    for (const id of ids) {
      await unwrapCommand(commands.localSpaceDeleteConflict(id));
    }
    await get().refresh();
  },
  dismissAll: async () => {
    await get().dismissIds(get().items.map((item) => item.id));
  },
  openOverview: () => set({ overviewOpen: true }),
  closeOverview: () => set({ overviewOpen: false }),
}));
