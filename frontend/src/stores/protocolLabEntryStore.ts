import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ProtocolTabKey } from "../lib/protocolLabConfig";

export interface ProtocolLabEntry {
  id: string;
  protocol: ProtocolTabKey;
  name: string;
  createdAt: number;
  updatedAt: number;
}

interface CreateProtocolLabEntryInput {
  protocol: ProtocolTabKey;
  name: string;
}

interface ProtocolLabEntryState {
  entries: ProtocolLabEntry[];
  createEntry: (input: CreateProtocolLabEntryInput) => ProtocolLabEntry;
  renameEntry: (id: string, name: string) => void;
  deleteEntry: (id: string) => void;
  getEntry: (id: string) => ProtocolLabEntry | undefined;
}

function makeEntryId(protocol: ProtocolTabKey): string {
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : String(Date.now());
  return `proto-entry-${protocol}-${suffix}`;
}

export const useProtocolLabEntryStore = create<ProtocolLabEntryState>()(
  persist(
    (set, get) => ({
      entries: [],
      createEntry: (input) => {
        const now = Date.now();
        const entry: ProtocolLabEntry = {
          id: makeEntryId(input.protocol),
          protocol: input.protocol,
          name: input.name.trim() || input.protocol,
          createdAt: now,
          updatedAt: now,
        };
        set((state) => ({ entries: [...state.entries, entry] }));
        return entry;
      },
      renameEntry: (id, name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        set((state) => ({
          entries: state.entries.map((entry) =>
            entry.id === id ? { ...entry, name: trimmed, updatedAt: Date.now() } : entry,
          ),
        }));
      },
      deleteEntry: (id) => {
        set((state) => ({
          entries: state.entries.filter((entry) => entry.id !== id),
        }));
      },
      getEntry: (id) => get().entries.find((entry) => entry.id === id),
    }),
    {
      name: "omnipanel-protocol-lab-entries.v1",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
