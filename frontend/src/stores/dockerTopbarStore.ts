import { create } from "zustand";

interface DockerTopbarState {
  refreshSignal: number;
  refreshing: boolean;
  requestRefresh: () => void;
  setRefreshing: (refreshing: boolean) => void;
}

export const useDockerTopbarStore = create<DockerTopbarState>((set) => ({
  refreshSignal: 0,
  refreshing: false,
  requestRefresh: () => set((s) => ({ refreshSignal: s.refreshSignal + 1 })),
  setRefreshing: (refreshing) => set({ refreshing }),
}));
