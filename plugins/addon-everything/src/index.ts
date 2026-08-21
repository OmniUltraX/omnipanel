import type { PluginManifest } from "@omnipanel/plugin-sdk";
import { parsePluginManifest } from "@omnipanel/plugin-sdk";
import raw from "../plugin.json";

export const everythingAddonManifest: PluginManifest = parsePluginManifest(raw);
export const EVERYTHING_LAUNCHER_PREFIX = "es";
export const EVERYTHING_TOOL_NAME = "omni_everything_search";
