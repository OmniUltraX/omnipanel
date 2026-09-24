/**
 * 侧栏条目备注（本机持久化，不同步）。
 * 键约定见 `lib/sidebarNotes.ts`。
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createSafeLocalStorage } from "../lib/zustandPersistStorage";

type SidebarNoteState = {
  notes: Record<string, string>;
  setNote: (key: string, text: string) => void;
  clearNote: (key: string) => void;
  getNote: (key: string) => string | undefined;
};

const STORAGE_KEY = "omnipanel.sidebarNotes.v1";

function normalizeNote(text: string): string {
  return text.trim();
}

export const useSidebarNoteStore = create<SidebarNoteState>()(
  persist(
    (set, get) => ({
      notes: {},
      setNote: (key, text) => {
        const trimmed = normalizeNote(text);
        if (!key.trim()) return;
        set((state) => {
          if (!trimmed) {
            if (!(key in state.notes)) return state;
            const next = { ...state.notes };
            delete next[key];
            return { notes: next };
          }
          if (state.notes[key] === trimmed) return state;
          return { notes: { ...state.notes, [key]: trimmed } };
        });
      },
      clearNote: (key) => {
        set((state) => {
          if (!(key in state.notes)) return state;
          const next = { ...state.notes };
          delete next[key];
          return { notes: next };
        });
      },
      getNote: (key) => {
        const value = get().notes[key];
        return value && value.trim() ? value : undefined;
      },
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(createSafeLocalStorage),
      partialize: (state) => ({ notes: state.notes }),
    },
  ),
);
