import { create } from "zustand";
import { commands, type AppModule, type AppModuleStatus } from "../ipc/bindings";
import {
  ALL_MODULE_KEYS,
  isKernelModuleKey,
  moduleKeyFromPath,
  navModuleKeyFromPath,
  type ModuleKey,
} from "../lib/paths";
import { listActivatedPluginModules } from "../lib/pluginModuleRegistry";

/** 用户可在设置中切换的状态 */
export type UserAppModuleStatus = Extract<AppModuleStatus, "open" | "closed">;

/** 模块未加载 DB 前的默认状态（与迁移种子一致） */
export const DEFAULT_MODULE_STATUS: Record<ModuleKey, AppModuleStatus> = {
  terminal: "open",
  ssh: "open",
  database: "open",
  docker: "open",
  server: "open",
  files: "open",
  cloud: "open",
  protocol: "open",
  workflow: "disabled",
  knowledge: "open",
  tasks: "open",
};

interface AppModuleStore {
  modules: AppModule[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  refresh: () => Promise<void>;
  getStatus: (key: string) => AppModuleStatus;
  setStatus: (key: string, status: UserAppModuleStatus) => Promise<void>;
}

export const useAppModuleStore = create<AppModuleStore>((set, get) => ({
  modules: [],
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    await get().refresh();
  },

  refresh: async () => {
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
    if (isKernelModuleKey(key)) return DEFAULT_MODULE_STATUS[key];
    // 已启用的 module 插件：尚未入库时默认可见，不必先去设置打开。
    if (listActivatedPluginModules().some((item) => item.moduleKey === key)) return "open";
    return "closed";
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
    await import("./builtinToolStore").then((m) => m.refreshBuiltinToolStore());
  },
}));

export function getModuleStatus(key: string): AppModuleStatus {
  return useAppModuleStore.getState().getStatus(key);
}

/** 模块是否处于「打开」状态（侧栏可见、可访问） */
export function isModuleOpen(key: string): boolean {
  return getModuleStatus(key) === "open";
}

export function getNavVisibleModuleKeys(): string[] {
  const { modules, hydrated } = useAppModuleStore.getState();
  const kernel = !hydrated || modules.length === 0
    ? ALL_MODULE_KEYS.filter((key) => DEFAULT_MODULE_STATUS[key] === "open")
    : modules
        .filter((m) => isKernelModuleKey(m.module_key) && m.status === "open")
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((m) => m.module_key);
  const plugin = listActivatedPluginModules()
    .filter((item) => getModuleStatus(item.moduleKey) === "open")
    .map((item) => item.moduleKey);
  return [...kernel, ...plugin];
}

export function isModulePathEnabled(path: string): boolean {
  const key = navModuleKeyFromPath(path);
  if (!key) return true;
  return isModuleOpen(key);
}

export async function initAppModuleStore(): Promise<void> {
  await useAppModuleStore.getState().hydrate();
}

export { moduleKeyFromPath };
