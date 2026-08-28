import type { ImporterContribution, ImporterField, PluginManifest } from "@omnipanel/plugin-sdk";
import type { PluginListItem } from "../ipc/bindings";
import { getPluginManifest } from "./pluginManifests";

export type ActiveImporter = {
  pluginId: string;
  importer: ImporterContribution;
};

export function importerEntries(importer: ImporterContribution): string[] {
  if (!importer.entry) return ["commandPalette", "settings", "home"];
  return Array.isArray(importer.entry) ? importer.entry : [importer.entry];
}

export function parseImporterContributions(manifest: PluginManifest | null): ImporterContribution[] {
  return manifest?.contributes.importers ?? [];
}

export function findImporter(
  pluginId: string,
  importerId: string,
): ActiveImporter | null {
  const importer = parseImporterContributions(getPluginManifest(pluginId)).find(
    (item) => item.id === importerId,
  );
  return importer ? { pluginId, importer } : null;
}

export function listActiveImporters(items: PluginListItem[]): ActiveImporter[] {
  const out: ActiveImporter[] = [];
  for (const item of items) {
    if (!item.enabled || !item.activated) continue;
    for (const importer of parseImporterContributions(getPluginManifest(item.id))) {
      out.push({ pluginId: item.id, importer });
    }
  }
  return out;
}

export function secretKeyFor(field: ImporterField, sourceId: string): string {
  return `${field.secretKeyPrefix ?? field.key}-${sourceId}`;
}

export function resolveImporterText(raw: string | undefined, t: (key: string) => string): string {
  const text = raw?.trim() ?? "";
  if (!text) return "";
  const translated = t(text);
  return translated;
}
