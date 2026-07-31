import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createIndexedDBStorage } from "../lib/indexedDbStorage";

export type FileFavorite = {
  id: string;
  connectionId: string;
  path: string;
  label: string;
  createdAt: number;
  /** 钉到全局收藏后展示在「全局收藏」区 */
  pinned?: boolean;
};

type FilesFavoritesState = {
  favorites: FileFavorite[];
  addFavorite: (input: {
    connectionId: string;
    path: string;
    label: string;
  }) => FileFavorite | null;
  removeFavorite: (id: string) => void;
  renameFavorite: (id: string, label: string) => void;
  setFavoritePinned: (id: string, pinned: boolean) => void;
  reset: () => void;
};

const STORAGE_KEY = "omnipanel.filesFavorites.v1";

function normalizePath(path: string): string {
  return path.trim();
}

function newId(): string {
  return `fav-${Date.now().toString(16)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeFavorite(raw: unknown): FileFavorite | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Partial<FileFavorite>;
  if (typeof o.id !== "string" || !o.id.trim()) return null;
  if (typeof o.connectionId !== "string" || !o.connectionId.trim()) return null;
  if (typeof o.path !== "string") return null;
  return {
    id: o.id,
    connectionId: o.connectionId,
    path: o.path,
    label: typeof o.label === "string" && o.label.trim() ? o.label : o.path || "/",
    createdAt: typeof o.createdAt === "number" && Number.isFinite(o.createdAt) ? o.createdAt : Date.now(),
    pinned: o.pinned === true,
  };
}

export const useFilesFavoritesStore = create<FilesFavoritesState>()(
  persist(
    (set, get) => ({
      favorites: [],
      addFavorite: ({ connectionId, path, label }) => {
        const normalizedPath = normalizePath(path);
        const trimmedLabel = label.trim() || normalizedPath || "/";
        if (!connectionId.trim()) return null;
        const existing = get().favorites.find(
          (item) => item.connectionId === connectionId && item.path === normalizedPath,
        );
        if (existing) return existing;
        const favorite: FileFavorite = {
          id: newId(),
          connectionId,
          path: normalizedPath,
          label: trimmedLabel,
          createdAt: Date.now(),
          pinned: false,
        };
        set((state) => ({ favorites: [favorite, ...state.favorites] }));
        return favorite;
      },
      removeFavorite: (id) =>
        set((state) => ({
          favorites: state.favorites.filter((item) => item.id !== id),
        })),
      renameFavorite: (id, label) => {
        const next = label.trim();
        if (!next) return;
        set((state) => ({
          favorites: state.favorites.map((item) =>
            item.id === id ? { ...item, label: next } : item,
          ),
        }));
      },
      setFavoritePinned: (id, pinned) =>
        set((state) => ({
          favorites: state.favorites.map((item) =>
            item.id === id ? { ...item, pinned } : item,
          ),
        })),
      reset: () => set({ favorites: [] }),
    }),
    {
      name: STORAGE_KEY,
      version: 2,
      storage: createJSONStorage(createIndexedDBStorage),
      partialize: (state) => ({ favorites: state.favorites }),
      migrate: (persistedState) => {
        if (!persistedState || typeof persistedState !== "object") {
          return { favorites: [] };
        }
        const raw = persistedState as { favorites?: unknown };
        const list = Array.isArray(raw.favorites) ? raw.favorites : [];
        return {
          favorites: list
            .map(sanitizeFavorite)
            .filter((item): item is FileFavorite => item != null),
        };
      },
    },
  ),
);

export function defaultFavoriteLabel(path: string, connectionName?: string): string {
  const trimmed = path.trim();
  const base =
    trimmed === "" || trimmed === "/"
      ? "/"
      : trimmed.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() || trimmed;
  if (connectionName?.trim()) return `${connectionName.trim()} · ${base}`;
  return base;
}
