import type { PluginManifest } from "@omnipanel/plugin-sdk";
import { MODULE_PREFIX } from "./paths";
import { isPluginActivated, usePluginRuntimeStore } from "../stores/pluginRuntimeStore";
import { listPluginManifests } from "./pluginManifests";

export type PluginModuleDescriptor = {
  pluginId: string;
  moduleKey: string;
  labelI18nKey: string;
  group: "primary" | "util";
  sortOrder: number;
};

function moduleKeyFromManifest(manifest: PluginManifest): string | null {
  const key = manifest.contributes.ui?.moduleKey?.trim();
  return key || null;
}

export function listPluginModuleCatalog(): PluginModuleDescriptor[] {
  const out: PluginModuleDescriptor[] = [];
  for (const manifest of listPluginManifests("module")) {
    const moduleKey = moduleKeyFromManifest(manifest);
    if (!moduleKey) continue;
    out.push({
      pluginId: manifest.id,
      moduleKey,
      labelI18nKey: `shell.nav.${moduleKey}`,
      group: "primary",
      sortOrder: 80,
    });
  }
  return out;
}

export function listActivatedPluginModules(): PluginModuleDescriptor[] {
  const hydrated = usePluginRuntimeStore.getState().hydrated;
  return listPluginModuleCatalog().filter(
    (item) => !hydrated || isPluginActivated(item.pluginId),
  );
}

export function getPluginModule(moduleKey: string): PluginModuleDescriptor | null {
  return listPluginModuleCatalog().find((item) => item.moduleKey === moduleKey) ?? null;
}

export function pluginModulePath(moduleKey: string): string {
  return `${MODULE_PREFIX}/${moduleKey}`;
}
