import type { PluginManifest } from "@omnipanel/plugin-sdk";
import { parsePluginManifest } from "@omnipanel/plugin-sdk";
import raw from "../plugin.json";

export const mongodbEngineManifest: PluginManifest = parsePluginManifest(raw);

export const MONGODB_ENGINE_KEY = "mongodb";
export const PLUGIN_ID_ENGINE_MONGODB = "omni.engine.mongodb";
