import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface DataDictionaryEntry {
  id: string;
  name: string;
  data: string;
  createdAt: number;
  updatedAt: number;
}

interface DataDictionaryState {
  dictionaries: DataDictionaryEntry[];
  addDictionary: (name: string, data: string) => DataDictionaryEntry;
  updateDictionary: (id: string, name: string, data: string) => void;
  deleteDictionary: (id: string) => void;
  getDictionary: (id: string) => DataDictionaryEntry | undefined;
  findByName: (name: string) => DataDictionaryEntry | undefined;
}

export const useDbDataDictionaryStore = create<DataDictionaryState>()(
  persist(
    (set, get) => ({
      dictionaries: [],

      addDictionary: (name, data) => {
        const now = Date.now();
        const entry: DataDictionaryEntry = {
          id: `dict-${crypto.randomUUID()}`,
          name: name.trim(),
          data,
          createdAt: now,
          updatedAt: now,
        };
        set((state) => ({
          dictionaries: [...state.dictionaries, entry],
        }));
        return entry;
      },

      updateDictionary: (id, name, data) => {
        set((state) => ({
          dictionaries: state.dictionaries.map((entry) =>
            entry.id === id
              ? { ...entry, name: name.trim(), data, updatedAt: Date.now() }
              : entry
          ),
        }));
      },

      deleteDictionary: (id) => {
        set((state) => ({
          dictionaries: state.dictionaries.filter((entry) => entry.id !== id),
        }));
      },

      getDictionary: (id) => {
        return get().dictionaries.find((entry) => entry.id === id);
      },

      findByName: (name) => {
        return get().dictionaries.find((entry) => entry.name === name.trim());
      },
    }),
    {
      name: "omnipanel-db-data-dictionary",
    }
  )
);