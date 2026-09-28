import type {
  PluginHomeContribution,
  PluginIcon,
  PluginManifest,
} from "@omnipanel/plugin-sdk";
import type { NavigateFunction } from "react-router-dom";
import { commands } from "../ipc/bindings";
import { unwrapCommand } from "../ipc/result";
import { getPluginManifest } from "./pluginManifests";
import { MODULE_PREFIX } from "./paths";
import { usePluginOverlayStore } from "../stores/pluginOverlayStore";
import { t } from "../i18n";
import type { EligibleHomePlugin } from "./pluginHomeContribution";

export type PluginIconTheme = "light" | "dark";

function pickIconPath(icon: PluginIcon | undefined, theme: PluginIconTheme): string | null {
  if (!icon) return null;
  if (typeof icon === "string") {
    const path = icon.trim();
    return path || null;
  }
  const path = (theme === "dark" ? icon.dark : icon.light).trim();
  return path || null;
}

/** 插件自带图标路径：顶层 `icon`（可含 light/dark）→ `ui.home.icon`。 */
export function resolvePluginIconPath(
  manifest: PluginManifest | null | undefined,
  theme: PluginIconTheme = "light",
): string | null {
  if (!manifest) return null;
  const top = pickIconPath(manifest.icon, theme);
  if (top) return top;
  const home = manifest.contributes.ui?.home?.icon?.trim();
  return home || null;
}

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
  // compat 垫片（转换插件）：失败不阻断主流程（垫片缺失时页内调用方自行报错）。
  let compatJs: string | undefined;
  const compatEntry = (
    manifest as unknown as { entry?: { compat?: unknown } }
  ).entry?.compat;
  if (typeof compatEntry === "string" && compatEntry.trim()) {
    try {
      compatJs = await unwrapCommand(commands.pluginReadAsset(pluginId, compatEntry.trim()));
    } catch {
      compatJs = undefined;
    }
  }
  const titleKey = overlay?.title?.trim();
  usePluginOverlayStore.getState().show({
    id: `${pluginId}:${overlay?.id ?? "overlay"}`,
    pluginId,
    title: titleKey ? t(titleKey) : pluginId,
    body: "",
    sandboxHtml: html,
    compatJs,
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

/**
 * 读取插件包内图标为可显示的 data URL。
 * PNG 资产 IPC 已返回 `data:image/png;base64,...`；SVG 为原文再包一层。
 */
export async function loadPluginIcon(
  pluginId: string,
  iconPath: string | undefined,
): Promise<string | null> {
  const rel = iconPath?.trim();
  if (!rel) return null;
  const key = `${pluginId}:${rel}:v4`;
  if (iconCache.has(key)) return iconCache.get(key) ?? null;
  try {
    const raw = await unwrapCommand(commands.pluginReadAsset(pluginId, rel));
    const lower = rel.toLowerCase();
    const src = raw.startsWith("data:")
      ? raw
      : lower.endsWith(".png")
        ? raw
        : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(raw)}`;
    iconCache.set(key, src);
    return src;
  } catch {
    iconCache.set(key, null);
    return null;
  }
}

/** @deprecated 使用 `loadPluginIcon`；保留别名避免外部调用断裂。 */
export const loadPluginHomeIcon = loadPluginIcon;

/** 按清单与主题解析并加载插件自带图标。 */
export async function loadPluginManifestIcon(
  pluginId: string,
  theme: PluginIconTheme = "light",
): Promise<string | null> {
  return loadPluginIcon(
    pluginId,
    resolvePluginIconPath(getPluginManifest(pluginId), theme) ?? undefined,
  );
}

/** 仅测试：清空图标缓存。 */
export function resetPluginHomeIconCacheForTests(): void {
  iconCache.clear();
}
