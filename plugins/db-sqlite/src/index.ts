import type { PluginManifest } from "@omnipanel/plugin-sdk";
import { parsePluginManifest } from "@omnipanel/plugin-sdk";
import raw from "../plugin.json";

export const sqliteEngineManifest: PluginManifest = parsePluginManifest(raw);

export const SQLITE_ENGINE_KEY = "sqlite";
export const PLUGIN_ID_ENGINE_SQLITE = "omni.engine.sqlite";
