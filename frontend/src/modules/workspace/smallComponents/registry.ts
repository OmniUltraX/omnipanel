import type { SmallComponentDefinition } from "./types";

/**
 * 首页自定义面板小组件注册表。
 * 推荐通过 `registerSmallComponentClass` 注册基类子类；
 * 也可直接 `registerSmallComponent(definition)`。
 */
const registry = new Map<string, SmallComponentDefinition>();

export function registerSmallComponent(def: SmallComponentDefinition): void {
  if (!def.sizes || def.sizes.length === 0) {
    console.warn(
      `[smallComponents] skip register "${def.type}": sizes must be non-empty`,
    );
    return;
  }
  if (registry.has(def.type)) {
    console.warn(`[smallComponents] duplicate type ignored: ${def.type}`);
    return;
  }
  registry.set(def.type, def);
}

export function getSmallComponent(type: string): SmallComponentDefinition | undefined {
  return registry.get(type);
}

export function listSmallComponents(): SmallComponentDefinition[] {
  return [...registry.values()];
}

export function hasSmallComponents(): boolean {
  return registry.size > 0;
}
