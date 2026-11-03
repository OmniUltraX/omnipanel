import { create } from "zustand";
import { commands, type SpaceConflict } from "../ipc/bindings";
import { unwrapCommand } from "../ipc/result";

interface SpaceConflictState {
  byPath: Record<string, SpaceConflict>;
  refresh: () => Promise<void>;
  dismiss: (id: string) => Promise<void>;
}

export const useSpaceConflictStore = create<SpaceConflictState>((set, get) => ({
  byPath: {},
  refresh: async () => {
    try {
      const list = await unwrapCommand(commands.localSpaceListConflicts(), { quiet: true });
      const byPath: Record<string, SpaceConflict> = {};
      for (const item of list) {
        if (!byPath[item.path]) byPath[item.path] = item;
      }
      set({ byPath });
    } catch {
      // 本机库还没打开时不打断界面
    }
  },
  dismiss: async (id) => {
    await unwrapCommand(commands.localSpaceDeleteConflict(id));
    await get().refresh();
  },
}));
