/**
 * 插件市场 / 已安装列表用的品牌图标。
 * - 引擎：复用 database/engineIcons
 * - 云 / 面板 / Docker：复用 server/brandIcons（侧栏同源）
 * - 其余：优先本地 vendored 的 SVGL 资产（见 assets/icons，来源 https://svgl.app）
 */
import type { PluginKind } from "../../ipc/bindings";
import obsidianIcon from "../../assets/icons/obsidian.svg";
import awsLightIcon from "../../assets/icons/aws-light.svg";
import awsDarkIcon from "../../assets/icons/aws-dark.svg";
import { getEngineIcon } from "../database/connection/engineIcons";
import { getPluginManifest } from "../../lib/pluginManifests";
import {
  getBrandIcon,
  resolvePanelBrandIcon,
  type BrandIconKind,
} from "../server/brandIcons";
import { cloudBrandKind } from "../cloud/cloudForm";

type Theme = "light" | "dark";

/** pluginId → 主题无关图标；或 { light, dark }。 */
const PLUGIN_ID_ICONS: Record<string, string | { light: string; dark: string }> = {
  "omni.knowledge.obsidian": obsidianIcon,
  "omni.importer.docker-db": getBrandIcon("docker"),
  // AWS：SVGL 提供明暗双色，市场里随主题切换
  "omni.cloud.aws": { light: awsLightIcon, dark: awsDarkIcon },
};

function engineKeyOf(pluginId: string, kind: PluginKind): string | null {
  if (kind !== "engine") return null;
  const form = getPluginManifest(pluginId)?.contributes.ui?.connectionForm;
  if (form && typeof form === "object") {
    const key = String((form as { engineKey?: unknown }).engineKey ?? "").trim();
    if (key) return key;
  }
  return pluginId.startsWith("omni.engine.") ? pluginId.slice("omni.engine.".length) : pluginId;
}

function pickTheme(
  entry: string | { light: string; dark: string },
  theme: Theme,
): string {
  return typeof entry === "string" ? entry : entry[theme];
}

function brandFromCloud(pluginId: string): BrandIconKind | null {
  const kind = cloudBrandKind(pluginId);
  if (kind === "server") return null;
  return kind;
}

/**
 * 解析插件市场条目图标 URL；无可用品牌图时返回 null（调用方走 kind 占位）。
 */
export function getPluginMarketIcon(
  pluginId: string,
  kind: PluginKind,
  theme: Theme,
): string | null {
  const id = pluginId.trim();
  if (!id) return null;

  const byId = PLUGIN_ID_ICONS[id];
  if (byId) return pickTheme(byId, theme);

  if (kind === "engine") {
    const engineKey = engineKeyOf(id, kind);
    return engineKey ? getEngineIcon(engineKey, theme) : null;
  }

  if (kind === "cloud") {
    // AWS 已在 PLUGIN_ID_ICONS；其余走本地品牌 SVG
    const brand = brandFromCloud(id);
    return brand ? getBrandIcon(brand) : null;
  }

  if (kind === "panel") {
    const panel = resolvePanelBrandIcon(id);
    return panel ? getBrandIcon(panel) : null;
  }

  return null;
}
