import type { PluginManifest } from "@omnipanel/plugin-sdk";
import { parsePluginManifest } from "@omnipanel/plugin-sdk";
import raw from "../plugin.json";

export const qdrantEngineManifest: PluginManifest = parsePluginManifest(raw);

export const QDRANT_ENGINE_KEY = "qdrant";
