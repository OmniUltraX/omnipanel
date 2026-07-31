import { create } from "zustand";

export type FileClipboardMode = "copy" | "cut";

export type FileClipboardItem = {
  connectionId: string;
  path: string;
  name: string;
  kind: "file" | "dir" | string;
  size?: number | null;
};

type FilesClipboardState = {
  mode: FileClipboardMode;
  items: FileClipboardItem[];
  capturedAt: number;
  copy: (items: FileClipboardItem[]) => void;
  cut: (items: FileClipboardItem[]) => void;
  clear: () => void;
  hasItems: () => boolean;
};

export const useFilesClipboardStore = create<FilesClipboardState>((set, get) => ({
  mode: "copy",
  items: [],
  capturedAt: 0,
  copy: (items) => {
    if (items.length === 0) return;
    set({ mode: "copy", items: [...items], capturedAt: Date.now() });
  },
  cut: (items) => {
    if (items.length === 0) return;
    set({ mode: "cut", items: [...items], capturedAt: Date.now() });
  },
  clear: () => set({ mode: "copy", items: [], capturedAt: 0 }),
  hasItems: () => get().items.length > 0,
}));
