import type { PluginManifest } from "@omnipanel/plugin-sdk";
import { parsePluginManifest } from "@omnipanel/plugin-sdk";
import raw from "../plugin.json";

export const postgresEngineManifest: PluginManifest = parsePluginManifest(raw);

export const POSTGRES_ENGINE_KEY = "postgresql";
export const PLUGIN_ID_ENGINE_POSTGRES = "omni.engine.postgres";
