import { nacosModuleManifest } from "../../../plugins/module-nacos/src/index";
import type { PluginManifest } from "@omnipanel/plugin-sdk";
import { MODULE_PREFIX } from "./paths";
import { isPluginActivated, usePluginRuntimeStore } from "../stores/pluginRuntimeStore";

export type PluginModuleDescriptor = {
  pluginId: string;
  moduleKey: string;
  labelI18nKey: string;
  group: "primary" | "util";
  sortOrder: number;
};

const MODULE_PLUGIN_MANIFESTS: Array<{ pluginId: string; manifest: PluginManifest }> = [
  { pluginId: "omni.module.nacos", manifest: nacosModuleManifest },
];

function moduleKeyFromManifest(manifest: PluginManifest): string | null {
  const key = manifest.contributes.ui?.moduleKey?.trim();
  return key || null;
}

export function listPluginModuleCatalog(): PluginModuleDescriptor[] {
  const out: PluginModuleDescriptor[] = [];
  for (const { pluginId, manifest } of MODULE_PLUGIN_MANIFESTS) {
    const moduleKey = moduleKeyFromManifest(manifest);
    if (!moduleKey) continue;
    out.push({
      pluginId,
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
