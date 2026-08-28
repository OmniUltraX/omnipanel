import { create } from "zustand";
import { persist } from "zustand/middleware";

interface PluginHomePinState {
  hiddenIds: string[];
  order: string[];
  isPinned: (pluginId: string) => boolean;
  setPinned: (pluginId: string, pinned: boolean) => void;
}

export const usePluginHomePinStore = create<PluginHomePinState>()(
  persist(
    (set, get) => ({
      hiddenIds: [],
      order: [],
      isPinned: (pluginId) => !get().hiddenIds.includes(pluginId),
      setPinned: (pluginId, pinned) => {
        set((state) => {
          const hiddenIds = state.hiddenIds.filter((id) => id !== pluginId);
          if (!pinned) hiddenIds.push(pluginId);
          const order = pinned
            ? state.order.includes(pluginId)
              ? state.order
              : [...state.order, pluginId]
            : state.order.filter((id) => id !== pluginId);
          return { hiddenIds, order };
        });
      },
    }),
    {
      name: "omnipanel-plugin-home-pins",
      partialize: (state) => ({
        hiddenIds: state.hiddenIds,
        order: state.order,
      }),
    },
  ),
);
