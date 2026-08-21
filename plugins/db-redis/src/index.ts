import type { PluginManifest } from "@omnipanel/plugin-sdk";
import { parsePluginManifest } from "@omnipanel/plugin-sdk";
import raw from "../plugin.json";

export const redisEngineManifest: PluginManifest = parsePluginManifest(raw);

export const REDIS_ENGINE_KEY = "redis";
export const PLUGIN_ID_ENGINE_REDIS = "omni.engine.redis";
