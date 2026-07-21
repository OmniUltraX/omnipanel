import { create } from "zustand";

/** Composer 显式多选上下文芯片（附件仍走 assistant-ui Attachment，不进此列表）。 */
export type ComposerContextItem =
  | { kind: "terminal"; id: string; label: string }
  | { kind: "ssh"; id: string; label: string }
  | { kind: "database"; id: string; label: string }
  | { kind: "docker"; id: string; label: string };

interface AiComposerContextState {
  items: ComposerContextItem[];
  addItem: (item: ComposerContextItem) => void;
  removeItem: (kind: ComposerContextItem["kind"], id: string) => void;
  clear: () => void;
}

export const useAiComposerContextStore = create<AiComposerContextState>((set) => ({
  items: [],
  addItem: (item) =>
    set((state) => {
      if (state.items.some((existing) => existing.kind === item.kind && existing.id === item.id)) {
        return state;
      }
      return { items: [...state.items, item] };
    }),
  removeItem: (kind, id) =>
    set((state) => ({
      items: state.items.filter((item) => !(item.kind === kind && item.id === id)),
    })),
  clear: () => set({ items: [] }),
}));

/** 非 hook 读取，供 buildAiContext 等路径使用。 */
export function getComposerContextItems(): ComposerContextItem[] {
  return useAiComposerContextStore.getState().items;
}

export function clearComposerContextItems(): void {
  useAiComposerContextStore.getState().clear();
}
