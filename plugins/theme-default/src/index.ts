import type { PluginManifest } from "@omnipanel/plugin-sdk";
import { parsePluginManifest } from "@omnipanel/plugin-sdk";
import raw from "../plugin.json";
import tokens from "../tokens.json";

export const themeDefaultManifest: PluginManifest = parsePluginManifest(raw);
export const themeDefaultTokens = tokens as {
  id?: string;
  js?: boolean;
  terminal?: unknown;
};

if (themeDefaultTokens.js) {
  throw new Error("theme v1 禁止 JS");
}
