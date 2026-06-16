import { create } from "zustand";
import { commands, type KnowledgeTodoItem, type KnowledgeTodoList } from "../ipc/bindings";

export function newTodoId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `todo-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createTodoItem(text = ""): KnowledgeTodoItem {
  return { id: newTodoId(), text, done: false };
}

export function createEmptyTodoList(title = "新待办列表"): KnowledgeTodoList {
  const now = Date.now();
  return {
    id: newTodoId(),
    title,
    items: [createTodoItem()],
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function nextTodoSortOrder(lists: KnowledgeTodoList[]): number {
  if (lists.length === 0) return 0;
  return Math.max(...lists.map((l) => l.sortOrder ?? 0)) + 1;
}

interface KnowledgeTodoStore {
  lists: KnowledgeTodoList[];
  isLoading: boolean;
  error: string | null;
  editingId: string | null;

  loadLists: () => Promise<void>;
  saveList: (list: KnowledgeTodoList) => Promise<boolean>;
  deleteList: (id: string) => Promise<void>;
  createList: () => Promise<string | null>;
  toggleItem: (listId: string, itemId: string) => Promise<void>;
  setEditingId: (id: string | null) => void;
  clearError: () => void;
}

export const useKnowledgeTodoStore = create<KnowledgeTodoStore>((set, get) => ({
  lists: [],
  isLoading: false,
  error: null,
  editingId: null,

  loadLists: async () => {
    set({ isLoading: true, error: null });
    try {
      const res = await commands.knowledgeTodoList();
      if (res.status === "ok") {
        set({ lists: res.data, isLoading: false });
      } else {
        set({ error: res.error.message, isLoading: false });
      }
    } catch (e) {
      set({ error: String(e), isLoading: false });
    }
  },

  saveList: async (list: KnowledgeTodoList) => {
    try {
      const payload: KnowledgeTodoList = {
        ...list,
        updatedAt: Date.now(),
      };
      const res = await commands.knowledgeTodoSave(payload);
      if (res.status === "ok") {
        set((state) => {
          const exists = state.lists.some((l) => l.id === list.id);
          const lists = exists
            ? state.lists.map((l) => (l.id === list.id ? payload : l))
            : [...state.lists, payload];
          return { lists };
        });
        return true;
      }
      set({ error: res.error.message });
      return false;
    } catch (e) {
      set({ error: String(e) });
      return false;
    }
  },

  deleteList: async (id: string) => {
    try {
      const res = await commands.knowledgeTodoDelete(id);
      if (res.status === "ok") {
        set((state) => ({
          lists: state.lists.filter((l) => l.id !== id),
          editingId: state.editingId === id ? null : state.editingId,
        }));
      } else {
        set({ error: res.error.message });
      }
    } catch (e) {
      set({ error: String(e) });
    }
  },

  createList: async () => {
    const list = createEmptyTodoList();
    list.sortOrder = nextTodoSortOrder(get().lists);
    list.items = [];
    const ok = await get().saveList(list);
    if (!ok) return null;
    get().setEditingId(list.id);
    return list.id;
  },

  toggleItem: async (listId: string, itemId: string) => {
    const list = get().lists.find((l) => l.id === listId);
    if (!list) return;
    const items = list.items.map((item) =>
      item.id === itemId ? { ...item, done: !item.done } : item,
    );
    await get().saveList({ ...list, items });
  },

  setEditingId: (id) => set({ editingId: id }),
  clearError: () => set({ error: null }),
}));
