import type { ModuleCapabilityDecl, ModuleProbeDecl, PluginManifest } from "@omnipanel/plugin-sdk";
import { MODULE_CAPABILITY_IDS } from "@omnipanel/plugin-sdk";

export const KNOWN_MODULE_CAPABILITY_IDS = MODULE_CAPABILITY_IDS;

export function manifestModuleCapabilities(manifest: PluginManifest | null): ModuleCapabilityDecl[] {
  if (!manifest) return [];
  return manifest.contributes.module?.capabilities ?? [];
}

export function manifestModuleProbe(manifest: PluginManifest | null): ModuleProbeDecl | null {
  return manifest?.contributes.module?.probe ?? null;
}

export function isKnownModuleCapability(id: string): boolean {
  return (KNOWN_MODULE_CAPABILITY_IDS as readonly string[]).includes(id);
}

export function parseServiceConfig(configText: string | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(configText || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function servicePluginId(configText: string | undefined): string {
  const pluginId = parseServiceConfig(configText).pluginId;
  return typeof pluginId === "string" ? pluginId.trim() : "";
}
