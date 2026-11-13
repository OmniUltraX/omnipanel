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
      set({ byPath, items, overviewOpen: items.length === 0 ? false : get().overviewOpen });
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
