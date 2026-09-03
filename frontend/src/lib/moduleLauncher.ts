import { getPluginManifest } from "./pluginManifests";
import {
  registerLauncherProvider,
  unregisterLauncherProvider,
} from "./quickLauncherMatch";

const registered = new Set<string>();

/** 按已激活 module 清单登记/卸除启动器前缀，不写产品名特判。 */
export function syncModuleLauncherProviders(
  items: Array<{ id: string; enabled: boolean; activated: boolean }>,
): void {
  const next = new Set<string>();
  for (const item of items) {
    if (!item.enabled || !item.activated) continue;
    const manifest = getPluginManifest(item.id);
    if (manifest?.kind !== "module") continue;
    const prefix = manifest.contributes.launcher?.prefix?.trim();
    if (!prefix) continue;
    const moduleKey = manifest.contributes.ui?.moduleKey?.trim() || prefix;
    next.add(prefix);
    registerLauncherProvider({
      prefix,
      parse: (raw, filter) => ({
        kind: "module",
        raw,
        filter,
        prefix,
        pluginId: manifest.id,
        moduleKey,
      }),
    });
  }
  for (const prefix of registered) {
    if (!next.has(prefix)) unregisterLauncherProvider(prefix);
  }
  registered.clear();
  for (const prefix of next) registered.add(prefix);
}
