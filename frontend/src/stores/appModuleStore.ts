import { create } from "zustand";
import { commands, type AppModule, type AppModuleStatus } from "../ipc/bindings";
import { ALL_MODULE_KEYS, moduleKeyFromPath, MODULE_PATHS, type ModuleKey } from "../lib/paths";

/** 用户可在设置中切换的状态 */
export type UserAppModuleStatus = Extract<AppModuleStatus, "open" | "closed">;

/** 模块未加载 DB 前的默认状态（与迁移种子一致） */
export const DEFAULT_MODULE_STATUS: Record<ModuleKey, AppModuleStatus> = {
  terminal: "open",
  database: "open",
  ssh: "open",
  docker: "open",
  server: "open",
  files: "open",
  protocol: "open",
  workflow: "disabled",
  knowledge: "open",
};

function isModuleKey(key: string): key is ModuleKey {
  return key in MODULE_PATHS;
}

interface AppModuleStore {
  modules: AppModule[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  getStatus: (key: ModuleKey) => AppModuleStatus;
  setStatus: (key: ModuleKey, status: UserAppModuleStatus) => Promise<void>;
}

export const useAppModuleStore = create<AppModuleStore>((set, get) => ({
  modules: [],
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const res = await commands.appModuleList();
      if (res.status === "ok") {
        set({ modules: res.data, hydrated: true });
      } else {
        set({ hydrated: true });
      }
    } catch {
      set({ hydrated: true });
    }
  },

  getStatus: (key) => {
    const mod = get().modules.find((m) => m.module_key === key);
    if (mod) return mod.status;
    return DEFAULT_MODULE_STATUS[key];
  },

  setStatus: async (key, status) => {
    const res = await commands.appModuleSetStatus(key, status);
    if (res.status !== "ok") return;
    const updated = res.data;
    set((state) => ({
      modules: state.modules.some((m) => m.module_key === key)
        ? state.modules.map((m) => (m.module_key === key ? updated : m))
        : [...state.modules, updated],
    }));
    await import("./mcpToolStore").then((m) => m.refreshMcpToolStore());
  },
}));

export function getModuleStatus(key: ModuleKey): AppModuleStatus {
  return useAppModuleStore.getState().getStatus(key);
}

/** 模块是否处于「打开」状态（侧栏可见、可访问） */
export function isModuleOpen(key: ModuleKey): boolean {
  return getModuleStatus(key) === "open";
}

/** @deprecated 使用 isModuleOpen */
export function isModuleEnabled(key: ModuleKey): boolean {
  return isModuleOpen(key);
}

export function getNavVisibleModuleKeys(): ModuleKey[] {
  const { modules, hydrated } = useAppModuleStore.getState();
  if (!hydrated || modules.length === 0) {
    return ALL_MODULE_KEYS.filter((key) => DEFAULT_MODULE_STATUS[key] === "open");
  }
  return modules
    .filter((m) => isModuleKey(m.module_key) && m.status === "open")
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((m) => m.module_key as ModuleKey);
}

export function isModulePathEnabled(path: string): boolean {
  const key = moduleKeyFromPath(path);
  if (!key) return true;
  return isModuleOpen(key);
}

export async function initAppModuleStore(): Promise<void> {
  await useAppModuleStore.getState().hydrate();
}

export { moduleKeyFromPath };
