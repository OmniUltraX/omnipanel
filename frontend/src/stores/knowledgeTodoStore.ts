import { create } from "zustand";
import { commands, type KnowledgeTodoItem_Serialize, type KnowledgeTodoList } from "../ipc/bindings";
import { formatIpcError } from "../ipc/result";

export function newTodoId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `todo-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createTodoItem(
  partial: Partial<Pick<KnowledgeTodoItem_Serialize, "name" | "executor" | "description" | "done">> = {},
): KnowledgeTodoItem_Serialize {
  return {
    id: newTodoId(),
    name: partial.name ?? "",
    executor: partial.executor ?? "",
    description: partial.description ?? "",
    done: partial.done ?? false,
  };
}

export function createEmptyTodoList(title = "新待办列表"): KnowledgeTodoList {
  const now = Date.now();
  return {
    id: newTodoId(),
    title,
    description: "",
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
  removeItem: (listId: string, itemId: string) => Promise<void>;
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
        set({
          lists: res.data.map((list) => ({
            ...list,
            description: list.description ?? "",
          })),
          isLoading: false,
        });
      } else {
        set({ error: formatIpcError(res.error), isLoading: false });
      }
    } catch (e) {
      set({ error: formatIpcError(e), isLoading: false });
    }
  },

  saveList: async (list: KnowledgeTodoList) => {
    try {
      const payload: KnowledgeTodoList = {
        ...list,
        description: list.description ?? "",
        items: list.items ?? [],
        sortOrder: list.sortOrder ?? 0,
        createdAt: list.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      };
      const res = await commands.knowledgeTodoSave(payload);
      if (res.status === "ok") {
        set((state) => {
          const exists = state.lists.some((l) => l.id === list.id);
          const lists = exists
            ? state.lists.map((l) => (l.id === list.id ? payload : l))
            : [...state.lists, payload];
          return { lists, error: null };
        });
        return true;
      }
      set({ error: formatIpcError(res.error) });
      return false;
    } catch (e) {
      set({ error: formatIpcError(e) });
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
          error: null,
        }));
      } else {
        set({ error: formatIpcError(res.error) });
      }
    } catch (e) {
      set({ error: formatIpcError(e) });
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

  removeItem: async (listId: string, itemId: string) => {
    const list = get().lists.find((l) => l.id === listId);
    if (!list) return;
    const items = list.items.filter((item) => item.id !== itemId);
    await get().saveList({ ...list, items });
  },

  setEditingId: (id) => set({ editingId: id }),
  clearError: () => set({ error: null }),
}));
