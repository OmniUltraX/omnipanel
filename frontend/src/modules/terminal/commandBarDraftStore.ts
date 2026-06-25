import { create } from "zustand";

interface CommandBarDraftState {
  drafts: Record<string, string>;
  draftVersion: Record<string, number>;
  setDraft: (sessionId: string, command: string) => void;
  consumeDraft: (sessionId: string) => string | null;
  getDraftVersion: (sessionId: string) => number;
}

export const useCommandBarDraftStore = create<CommandBarDraftState>((set, get) => ({
  drafts: {},
  draftVersion: {},

  setDraft: (sessionId, command) =>
    set((state) => ({
      drafts: { ...state.drafts, [sessionId]: command },
      draftVersion: {
        ...state.draftVersion,
        [sessionId]: (state.draftVersion[sessionId] ?? 0) + 1,
      },
    })),

  consumeDraft: (sessionId) => {
    const draft = get().drafts[sessionId];
    if (!draft) return null;
    set((state) => {
      const drafts = { ...state.drafts };
      delete drafts[sessionId];
      return { drafts };
    });
    return draft;
  },

  getDraftVersion: (sessionId) => get().draftVersion[sessionId] ?? 0,
}));
