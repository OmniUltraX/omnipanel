import type { PluginManifest } from "@omnipanel/plugin-sdk";
import { parsePluginManifest } from "@omnipanel/plugin-sdk";
import raw from "../plugin.json";

export const clickhouseEngineManifest: PluginManifest = parsePluginManifest(raw);

export const CLICKHOUSE_ENGINE_KEY = "clickhouse";
export const PLUGIN_ID_ENGINE_CLICKHOUSE = "omni.engine.clickhouse";
