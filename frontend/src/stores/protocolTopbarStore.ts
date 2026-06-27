import { create } from "zustand";

interface ProtocolTopbarState {
  newRequestSignal: number;
  triggerNewRequest: () => void;
}

export const useProtocolTopbarStore = create<ProtocolTopbarState>((set) => ({
  newRequestSignal: 0,
  triggerNewRequest: () => set((state) => ({ newRequestSignal: state.newRequestSignal + 1 })),
}));
