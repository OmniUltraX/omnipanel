import type { ModuleDescriptor, ModuleRegistryId } from "./types";

const modules = new Map<ModuleRegistryId, ModuleDescriptor>();

/** 开发期重复注册会覆盖；HMR / 多入口 ensure 属预期，不打 error 刷屏 */
export function registerModule(descriptor: ModuleDescriptor): void {
  modules.set(descriptor.id, descriptor);
}

export function unregisterModule(id: ModuleRegistryId): boolean {
  return modules.delete(id);
}

export function getModule(id: ModuleRegistryId): ModuleDescriptor | undefined {
  return modules.get(id);
}

/** 注册顺序稳定（Map 插入序） */
export function listModules(): ModuleDescriptor[] {
  return [...modules.values()];
}

export function clearModuleRegistryForTests(): void {
  modules.clear();
}
