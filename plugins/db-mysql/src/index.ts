import type { PluginManifest } from "@omnipanel/plugin-sdk";
import { parsePluginManifest } from "@omnipanel/plugin-sdk";
import raw from "../plugin.json";

export const mysqlEngineManifest: PluginManifest = parsePluginManifest(raw);

export const MYSQL_ENGINE_KEY = "mysql";
export const PLUGIN_ID_ENGINE_MYSQL = "omni.engine.mysql";
