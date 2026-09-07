import type { ModuleDescriptor, ModuleRegistryId } from "./types";

const modules = new Map<ModuleRegistryId, ModuleDescriptor>();

/** 开发期重复注册会覆盖并打日志，避免静默分叉 */
export function registerModule(descriptor: ModuleDescriptor): void {
  if (modules.has(descriptor.id)) {
    console.error(
      `[module-runtime] duplicate registerModule("${descriptor.id}"), overriding`,
    );
  }
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
