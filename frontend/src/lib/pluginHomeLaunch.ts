import type { PluginHomeContribution } from "@omnipanel/plugin-sdk";
import type { NavigateFunction } from "react-router-dom";
import { commands } from "../ipc/bindings";
import { unwrapCommand } from "../ipc/result";
import { getPluginManifest } from "./pluginManifests";
import { MODULE_PREFIX } from "./paths";
import { usePluginOverlayStore } from "../stores/pluginOverlayStore";
import { t } from "../i18n";
import type { EligibleHomePlugin } from "./pluginHomeContribution";

export type { EligibleHomePlugin } from "./pluginHomeContribution";
export {
  listEligibleHomePlugins,
  listPinnedHomePlugins,
  parsePluginHomeContribution,
} from "./pluginHomeContribution";

type OverlayDecl = {
  id?: string;
  title?: string;
  entry?: string;
};

export function resolveHomeTitle(home: PluginHomeContribution): string {
  const translated = t(home.title);
  return translated === home.title && home.title.includes(".") ? home.title : translated;
}

export async function openPluginOverlay(
  pluginId: string,
  overlayId?: string,
  initialText?: string,
): Promise<void> {
  const manifest = getPluginManifest(pluginId);
  const overlays = (manifest?.contributes.overlays ?? []) as OverlayDecl[];
  const overlay =
    (overlayId ? overlays.find((item) => item.id === overlayId) : undefined) ?? overlays[0];
  const entry = overlay?.entry ?? "ui/index.html";
  const html = await unwrapCommand(commands.pluginReadAsset(pluginId, entry));
  const titleKey = overlay?.title?.trim();
  usePluginOverlayStore.getState().show({
    id: `${pluginId}:${overlay?.id ?? "overlay"}`,
    pluginId,
    title: titleKey ? t(titleKey) : pluginId,
    body: "",
    sandboxHtml: html,
    initialText,
  });
}

export async function openPluginHome(
  entry: EligibleHomePlugin,
  navigate: NavigateFunction,
): Promise<void> {
  const { kind, id } = entry.home.open;
  if (kind === "importer") {
    const { openImporter } = await import("../modules/importer/ImporterWizardDialog");
    openImporter(entry.pluginId, id);
    return;
  }
  if (kind === "overlay") {
    await openPluginOverlay(entry.pluginId, id);
    return;
  }
  const { navigateToFeature } = await import("./workspaceNavigation");
  navigateToFeature(`${MODULE_PREFIX}/${id}`, navigate);
}

const iconCache = new Map<string, string | null>();

export async function loadPluginHomeIcon(
  pluginId: string,
  iconPath: string | undefined,
): Promise<string | null> {
  const rel = iconPath?.trim();
  if (!rel) return null;
  const key = `${pluginId}:${rel}:v3`;
  if (iconCache.has(key)) return iconCache.get(key) ?? null;
  try {
    const raw = await unwrapCommand(commands.pluginReadAsset(pluginId, rel));
    const src = raw.startsWith("data:")
      ? raw
      : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(raw)}`;
    iconCache.set(key, src);
    return src;
  } catch {
    iconCache.set(key, null);
    return null;
  }
}

/** 仅测试：清空图标缓存。 */
export function resetPluginHomeIconCacheForTests(): void {
  iconCache.clear();
}
