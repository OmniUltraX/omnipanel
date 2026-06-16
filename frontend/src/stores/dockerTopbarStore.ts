import { create } from "zustand";

interface DockerTopbarState {
  refresh: (() => void) | null;
  refreshing: boolean;
  setRefresh: (refresh: (() => void) | null, refreshing?: boolean) => void;
}

export const useDockerTopbarStore = create<DockerTopbarState>((set) => ({
  refresh: null,
  refreshing: false,
  setRefresh: (refresh, refreshing = false) => set({ refresh, refreshing }),
}));
