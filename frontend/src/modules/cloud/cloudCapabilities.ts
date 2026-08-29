import type { CloudCapabilityDecl } from "@omnipanel/plugin-sdk";
import { getPluginManifest, listPluginManifests, manifestCloudCapabilities } from "../../lib/pluginManifests";
import { isPluginActivated, usePluginRuntimeStore } from "../../stores/pluginRuntimeStore";

export function activatedCloudPluginIds(): string[] {
  return listPluginManifests("cloud")
    .map((m) => m.id)
    .filter((id) => isPluginActivated(id));
}

export function cloudCapabilitiesForPlugin(pluginId: string | null | undefined): CloudCapabilityDecl[] {
  const id = (pluginId ?? "").trim();
  if (!id) return [];
  const hydrated = usePluginRuntimeStore.getState().hydrated;
  if (hydrated && !isPluginActivated(id)) return [];
  return manifestCloudCapabilities(getPluginManifest(id));
}

export function cloudCapabilityById(
  pluginId: string,
  capabilityId: string,
): CloudCapabilityDecl | null {
  return cloudCapabilitiesForPlugin(pluginId).find((cap) => cap.id === capabilityId) ?? null;
}

export function isGlobalCloudCapability(capability: CloudCapabilityDecl | null | undefined): boolean {
  return capability?.scope === "global";
}

/** 当前 Dock 落在 global 能力时隐藏地域条；账户概览仍显示（用于过滤树）。 */
export function shouldShowCloudRegionFilter(
  capabilities: CloudCapabilityDecl[],
  activeCapabilityId: string | null | undefined,
): boolean {
  if (activeCapabilityId) {
    const cap = capabilities.find((item) => item.id === activeCapabilityId);
    if (cap?.scope === "global") return false;
  }
  return capabilities.some((item) => item.scope !== "global");
}
