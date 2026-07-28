import { create } from "zustand";
import {
  commands,
  type TodoList,
  type TodoStep,
  type TodoTask,
  type TodoTaskQuery,
} from "../ipc/bindings";
import { formatIpcError } from "../ipc/result";

export type TodoSmartView = "myDay" | "important" | "planned" | "tasks";

export function newTodoId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `todo-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** 本地日历日 YYYY-MM-DD */
export function localYmd(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function startOfLocalDay(d = new Date()): number {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

export function addDaysLocal(base: Date, days: number): Date {
  const x = new Date(base);
  x.setDate(x.getDate() + days);
  return x;
}

function nextSortOrder(tasks: TodoTask[]): number {
  if (tasks.length === 0) return 0;
  return Math.max(...tasks.map((t) => t.sortOrder ?? 0)) + 1;
}

interface UserTodoStore {
  lists: TodoList[];
  tasks: TodoTask[];
  selectedTask: TodoTask | null;
  isLoading: boolean;
  error: string | null;
  activeQuery: TodoTaskQuery;

  loadLists: () => Promise<void>;
  loadTasks: (query: TodoTaskQuery) => Promise<void>;
  selectTask: (id: string | null) => Promise<void>;
  createList: (title?: string) => Promise<string | null>;
  renameList: (id: string, title: string) => Promise<boolean>;
  deleteList: (id: string) => Promise<boolean>;
  createTask: (
    title: string,
    listId?: string,
    opts?: {
      dueAt?: number | null;
      remindAt?: number | null;
      recurrenceFreq?: string | null;
    },
  ) => Promise<string | null>;
  saveTask: (task: TodoTask, replaceSteps?: boolean) => Promise<boolean>;
  deleteTask: (id: string) => Promise<boolean>;
  toggleComplete: (id: string) => Promise<void>;
  toggleImportant: (id: string) => Promise<void>;
  toggleMyDay: (id: string) => Promise<void>;
  setDueAt: (id: string, dueAt: number | null) => Promise<void>;
  setRemindAt: (id: string, remindAt: number | null) => Promise<void>;
  setRecurrence: (id: string, freq: string | null) => Promise<void>;
  addStep: (taskId: string, title: string) => Promise<void>;
  renameStep: (taskId: string, stepId: string, title: string) => Promise<void>;
  toggleStep: (taskId: string, stepId: string) => Promise<void>;
  removeStep: (taskId: string, stepId: string) => Promise<void>;
  clearError: () => void;
}

export const useUserTodoStore = create<UserTodoStore>((set, get) => ({
  lists: [],
  tasks: [],
  selectedTask: null,
  isLoading: false,
  error: null,
  activeQuery: { view: "tasks", includeCompleted: true },

  loadLists: async () => {
    try {
      const res = await commands.todoListList();
      if (res.status === "ok") {
        set({ lists: res.data, error: null });
      } else {
        set({ error: formatIpcError(res.error) });
      }
    } catch (e) {
      set({ error: formatIpcError(e) });
    }
  },

  loadTasks: async (query) => {
    set({ isLoading: true, activeQuery: query, error: null });
    try {
      const res = await commands.todoTaskList({
        ...query,
        includeCompleted: query.includeCompleted ?? true,
        today: query.today ?? localYmd(),
      });
      if (res.status === "ok") {
        set({ tasks: res.data, isLoading: false });
      } else {
        set({ error: formatIpcError(res.error), isLoading: false });
      }
    } catch (e) {
      set({ error: formatIpcError(e), isLoading: false });
    }
  },

  selectTask: async (id) => {
    if (!id) {
      set({ selectedTask: null });
      return;
    }
    try {
      const res = await commands.todoTaskGet(id);
      if (res.status === "ok") {
        set({ selectedTask: res.data, error: null });
      } else {
        set({ error: formatIpcError(res.error) });
      }
    } catch (e) {
      set({ error: formatIpcError(e) });
    }
  },

  createList: async (title = "新列表") => {
    const now = Date.now();
    const list: TodoList = {
      id: newTodoId(),
      title,
      isDefault: false,
      sortOrder: get().lists.filter((l) => !l.isDefault).length + 1,
      createdAt: now,
      updatedAt: now,
    };
    try {
      const res = await commands.todoListSave(list);
      if (res.status === "ok") {
        set((s) => ({ lists: [...s.lists, list], error: null }));
        return list.id;
      }
      set({ error: formatIpcError(res.error) });
      return null;
    } catch (e) {
      set({ error: formatIpcError(e) });
      return null;
    }
  },

  renameList: async (id, title) => {
    const prev = get().lists.find((l) => l.id === id);
    if (!prev) return false;
    const list = { ...prev, title, updatedAt: Date.now() };
    try {
      const res = await commands.todoListSave(list);
      if (res.status === "ok") {
        set((s) => ({
          lists: s.lists.map((l) => (l.id === id ? list : l)),
          error: null,
        }));
        return true;
      }
      set({ error: formatIpcError(res.error) });
      return false;
    } catch (e) {
      set({ error: formatIpcError(e) });
      return false;
    }
  },

  deleteList: async (id) => {
    try {
      const res = await commands.todoListDelete(id);
      if (res.status === "ok") {
        set((s) => ({
          lists: s.lists.filter((l) => l.id !== id),
          error: null,
        }));
        return true;
      }
      set({ error: formatIpcError(res.error) });
      return false;
    } catch (e) {
      set({ error: formatIpcError(e) });
      return false;
    }
  },

  createTask: async (title, listId, opts) => {
    const trimmed = title.trim();
    if (!trimmed) return null;
    const lists = get().lists;
    const defaultList = lists.find((l) => l.isDefault) ?? lists[0];
    const targetListId = listId ?? defaultList?.id;
    if (!targetListId) {
      await get().loadLists();
      const again = get().lists.find((l) => l.isDefault) ?? get().lists[0];
      if (!again) {
        set({ error: "没有可用的待办列表" });
        return null;
      }
      return get().createTask(trimmed, again.id, opts);
    }
    const now = Date.now();
    const q = get().activeQuery;
    const task: TodoTask = {
      id: newTodoId(),
      listId: targetListId,
      title: trimmed,
      note: "",
      important: q.view === "important",
      myDayOn: q.view === "myDay" ? localYmd() : null,
      dueAt: opts?.dueAt ?? null,
      remindAt: opts?.remindAt ?? null,
      recurrence: opts?.recurrenceFreq
        ? { freq: opts.recurrenceFreq, interval: 1 }
        : null,
      completed: false,
      completedAt: null,
      sortOrder: nextSortOrder(get().tasks),
      createdAt: now,
      updatedAt: now,
      steps: [],
      stepsTotal: 0,
      stepsDone: 0,
    };
    const ok = await get().saveTask(task, true);
    if (ok) void get().loadTasks(get().activeQuery);
    return ok ? task.id : null;
  },

  saveTask: async (task, replaceSteps = false) => {
    const payload: TodoTask = {
      ...task,
      note: task.note ?? "",
      important: task.important ?? false,
      completed: task.completed ?? false,
      sortOrder: task.sortOrder ?? 0,
      createdAt: task.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      steps: task.steps ?? [],
    };
    try {
      const res = await commands.todoTaskSave(payload, replaceSteps);
      if (res.status === "ok") {
        set((s) => {
          const exists = s.tasks.some((t) => t.id === payload.id);
          const tasks = exists
            ? s.tasks.map((t) => (t.id === payload.id ? { ...t, ...payload } : t))
            : [...s.tasks, payload];
          const selectedTask =
            s.selectedTask?.id === payload.id
              ? {
                  ...payload,
                  steps: replaceSteps ? payload.steps : s.selectedTask.steps,
                }
              : s.selectedTask;
          return { tasks, selectedTask, error: null };
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

  deleteTask: async (id) => {
    try {
      const res = await commands.todoTaskDelete(id);
      if (res.status === "ok") {
        set((s) => ({
          tasks: s.tasks.filter((t) => t.id !== id),
          selectedTask: s.selectedTask?.id === id ? null : s.selectedTask,
          error: null,
        }));
        return true;
      }
      set({ error: formatIpcError(res.error) });
      return false;
    } catch (e) {
      set({ error: formatIpcError(e) });
      return false;
    }
  },

  toggleComplete: async (id) => {
    const task = get().tasks.find((t) => t.id === id) ?? get().selectedTask;
    if (!task || task.id !== id) return;
    const completed = !(task.completed ?? false);
    await get().saveTask(
      {
        ...task,
        completed,
        completedAt: completed ? Date.now() : null,
      },
      false,
    );
    void get().loadTasks(get().activeQuery);
  },

  toggleImportant: async (id) => {
    const task = get().tasks.find((t) => t.id === id) ?? get().selectedTask;
    if (!task || task.id !== id) return;
    await get().saveTask({ ...task, important: !(task.important ?? false) }, false);
    void get().loadTasks(get().activeQuery);
  },

  toggleMyDay: async (id) => {
    const task = get().tasks.find((t) => t.id === id) ?? get().selectedTask;
    if (!task || task.id !== id) return;
    const today = localYmd();
    const on = task.myDayOn === today ? null : today;
    await get().saveTask({ ...task, myDayOn: on }, false);
    void get().loadTasks(get().activeQuery);
  },

  setDueAt: async (id, dueAt) => {
    const task = get().tasks.find((t) => t.id === id) ?? get().selectedTask;
    if (!task || task.id !== id) return;
    await get().saveTask({ ...task, dueAt }, false);
    void get().loadTasks(get().activeQuery);
  },

  setRemindAt: async (id, remindAt) => {
    const task = get().tasks.find((t) => t.id === id) ?? get().selectedTask;
    if (!task || task.id !== id) return;
    await get().saveTask({ ...task, remindAt }, false);
  },

  setRecurrence: async (id, freq) => {
    const task = get().tasks.find((t) => t.id === id) ?? get().selectedTask;
    if (!task || task.id !== id) return;
    await get().saveTask(
      {
        ...task,
        recurrence: freq ? { freq, interval: 1 } : null,
      },
      false,
    );
  },

  addStep: async (taskId, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    let task = get().selectedTask?.id === taskId ? get().selectedTask : null;
    if (!task) {
      const res = await commands.todoTaskGet(taskId);
      if (res.status !== "ok" || !res.data) return;
      task = res.data;
    }
    const steps = [...(task.steps ?? [])];
    const step: TodoStep = {
      id: newTodoId(),
      taskId,
      title: trimmed,
      done: false,
      sortOrder: steps.length,
    };
    steps.push(step);
    await get().saveTask({ ...task, steps, stepsTotal: steps.length }, true);
    await get().selectTask(taskId);
  },

  renameStep: async (taskId, stepId, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    const task = get().selectedTask?.id === taskId ? get().selectedTask : null;
    if (!task) return;
    const prev = (task.steps ?? []).find((s) => s.id === stepId);
    if (!prev || prev.title === trimmed) return;
    const steps = (task.steps ?? []).map((s) =>
      s.id === stepId ? { ...s, title: trimmed } : s,
    );
    // 乐观更新，避免失焦后整表重载打断输入
    set((s) => ({
      selectedTask:
        s.selectedTask?.id === taskId ? { ...s.selectedTask, steps } : s.selectedTask,
    }));
    await get().saveTask({ ...task, steps }, true);
  },

  toggleStep: async (taskId, stepId) => {
    const task = get().selectedTask?.id === taskId ? get().selectedTask : null;
    if (!task) return;
    const steps = (task.steps ?? []).map((s) =>
      s.id === stepId ? { ...s, done: !(s.done ?? false) } : s,
    );
    const stepsDone = steps.filter((s) => s.done).length;
    await get().saveTask({ ...task, steps, stepsDone, stepsTotal: steps.length }, true);
    await get().selectTask(taskId);
  },

  removeStep: async (taskId, stepId) => {
    const task = get().selectedTask?.id === taskId ? get().selectedTask : null;
    if (!task) return;
    const steps = (task.steps ?? []).filter((s) => s.id !== stepId);
    await get().saveTask(
      {
        ...task,
        steps,
        stepsTotal: steps.length,
        stepsDone: steps.filter((s) => s.done).length,
      },
      true,
    );
    await get().selectTask(taskId);
  },

  clearError: () => set({ error: null }),
}));

export function defaultListId(lists: TodoList[]): string | undefined {
  return lists.find((l) => l.isDefault)?.id ?? lists[0]?.id;
}

export function pendingTaskCount(tasks: TodoTask[]): number {
  return tasks.filter((t) => !t.completed).length;
}
