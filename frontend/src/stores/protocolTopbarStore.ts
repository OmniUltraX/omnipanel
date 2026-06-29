import { create } from "zustand";
import type { ProtocolTabKey } from "../lib/protocolLabConfig";

export type ProtocolPickerIntent = "new-tab" | "new-request";

export interface ProtocolPickerContext {
  intent: ProtocolPickerIntent;
  parentFolderId: string | null;
  sessionName?: string;
}

interface ProtocolTopbarState {
  newRequestSignal: number;
  newTabPickerOpen: boolean;
  pickerIntent: ProtocolPickerIntent;
  pickerParentFolderId: string | null;
  pickerPreselectedProtocol: ProtocolTabKey | null;
  triggerNewRequest: () => void;
  setNewTabPickerOpen: (open: boolean) => void;
  requestNewTabPicker: (preselectedProtocol?: ProtocolTabKey | null) => void;
  requestNewRequestPicker: (
    parentFolderId?: string | null,
    preselectedProtocol?: ProtocolTabKey | null,
  ) => void;
  getPickerContext: () => ProtocolPickerContext;
}

function resetPickerState() {
  return {
    newTabPickerOpen: false,
    pickerIntent: "new-tab" as const,
    pickerParentFolderId: null,
    pickerPreselectedProtocol: null,
  };
}

export const useProtocolTopbarStore = create<ProtocolTopbarState>((set, get) => ({
  newRequestSignal: 0,
  newTabPickerOpen: false,
  pickerIntent: "new-tab",
  pickerParentFolderId: null,
  pickerPreselectedProtocol: null,
  triggerNewRequest: () => set((state) => ({ newRequestSignal: state.newRequestSignal + 1 })),
  setNewTabPickerOpen: (open) => {
    if (!open) {
      set(resetPickerState());
      return;
    }
    set({ newTabPickerOpen: true });
  },
  requestNewTabPicker: (preselectedProtocol = null) =>
    set({
      newTabPickerOpen: true,
      pickerIntent: "new-tab",
      pickerParentFolderId: null,
      pickerPreselectedProtocol: preselectedProtocol,
    }),
  requestNewRequestPicker: (parentFolderId = null, preselectedProtocol = null) =>
    set({
      newTabPickerOpen: true,
      pickerIntent: "new-request",
      pickerParentFolderId: parentFolderId,
      pickerPreselectedProtocol: preselectedProtocol,
    }),
  getPickerContext: () => ({
    intent: get().pickerIntent,
    parentFolderId: get().pickerParentFolderId,
  }),
}));

export type ProtocolPickerSelectHandler = (
  protocol: ProtocolTabKey,
  context: ProtocolPickerContext,
) => void | Promise<void>;

let pickerSelectHandler: ProtocolPickerSelectHandler | null = null;

export function registerProtocolPickerSelectHandler(handler: ProtocolPickerSelectHandler | null) {
  pickerSelectHandler = handler;
}

export async function dispatchProtocolPickerSelect(protocol: ProtocolTabKey, sessionName: string) {
  const context: ProtocolPickerContext = {
    ...useProtocolTopbarStore.getState().getPickerContext(),
    sessionName: sessionName.trim(),
  };
  if (pickerSelectHandler) {
    await pickerSelectHandler(protocol, context);
  }
}
