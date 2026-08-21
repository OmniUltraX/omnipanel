import type { PluginManifest } from "@omnipanel/plugin-sdk";
import { parsePluginManifest } from "@omnipanel/plugin-sdk";
import raw from "../plugin.json";

export const nacosModuleManifest: PluginManifest = parsePluginManifest(raw);

export const PLUGIN_ID_MODULE_NACOS = "omni.module.nacos";
export const NACOS_MODULE_KEY = "nacos";
