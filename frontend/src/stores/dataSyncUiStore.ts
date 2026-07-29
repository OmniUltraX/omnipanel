import { create } from "zustand";

interface DataSyncUiState {
  open: boolean;
  openDataSync: () => void;
  closeDataSync: () => void;
}

export const useDataSyncUiStore = create<DataSyncUiState>((set) => ({
  open: false,
  openDataSync: () => set({ open: true }),
  closeDataSync: () => set({ open: false }),
}));
