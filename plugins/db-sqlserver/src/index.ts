import type { PluginManifest } from "@omnipanel/plugin-sdk";
import { parsePluginManifest } from "@omnipanel/plugin-sdk";
import raw from "../plugin.json";

export const sqlserverEngineManifest: PluginManifest = parsePluginManifest(raw);

export const SQLSERVER_ENGINE_KEY = "sqlserver";
export const PLUGIN_ID_ENGINE_SQLSERVER = "omni.engine.sqlserver";
