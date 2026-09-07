import type { ModuleRegistryId } from "./types";
import type { ModuleSessionService } from "./types";
import { getModule } from "./registry";

const instances = new Map<ModuleRegistryId, ModuleSessionService>();

/** 按 Descriptor 惰性创建并缓存 SessionService */
export function ensureSessionService(
  id: ModuleRegistryId,
): ModuleSessionService | null {
  const existing = instances.get(id);
  if (existing) return existing;
  const descriptor = getModule(id);
  if (!descriptor?.createSessionService) return null;
  const service = descriptor.createSessionService();
  instances.set(id, service);
  return service;
}

export function getSessionService(
  id: ModuleRegistryId,
): ModuleSessionService | null {
  return instances.get(id) ?? ensureSessionService(id);
}

/** 模块从保活集合踢出时通知 Session（默认应保留会话） */
export function notifyModuleEvicted(id: ModuleRegistryId): void {
  getSessionService(id)?.onModuleEvicted?.();
}

export function clearSessionServicesForTests(): void {
  instances.clear();
}
