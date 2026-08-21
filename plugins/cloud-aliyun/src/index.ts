import type { PluginManifest } from "@omnipanel/plugin-sdk";
import { parsePluginManifest } from "@omnipanel/plugin-sdk";
import raw from "../plugin.json";

export const cloudAliyunManifest: PluginManifest = parsePluginManifest(raw);

export const ALIYUN_CLOUD_TABS = ["ecs", "swas", "oss", "domains", "certs"] as const;
export type AliyunCloudTab = (typeof ALIYUN_CLOUD_TABS)[number];
