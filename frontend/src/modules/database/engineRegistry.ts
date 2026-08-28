import type { PluginManifest } from "@omnipanel/plugin-sdk";
import { isPluginActivated, usePluginRuntimeStore } from "../../stores/pluginRuntimeStore";
import { FIRST_PARTY_PLUGIN_MANIFESTS, listPluginManifests } from "../../lib/pluginManifests";
import {
  parseEngineWorkbench,
  SQL_WORKBENCH,
  UNAVAILABLE_WORKBENCH,
  type EngineWorkbench,
} from "./workbench/engineWorkbench";

export type { EngineWorkbench } from "./workbench/engineWorkbench";

export type EngineFormFieldType = "text" | "password" | "number" | "checkbox" | "path";

export type EngineFormField = {
  key: "host" | "port" | "database" | "username" | "password" | "ssl" | string;
  type: EngineFormFieldType;
  label?: string;
  optional?: boolean;
};

export type EngineDescriptor = {
  id: string;
  pluginId?: string;
  aliases: string[];
  defaultPort: number;
  icon: string;
  /** 内置布局；未知引擎走 form.fields */
  builtinLayout: boolean;
  supported: boolean;
  /** 连接对话框芯片顺序，越小越靠前 */
  order: number;
  form: { fields: EngineFormField[] };
  workbench: EngineWorkbench;
};

type PluginConnectionForm = {
  engineKey?: string;
  aliases?: string[];
  defaultPort?: number;
  icon?: string;
  fields?: EngineFormField[];
  builtinLayout?: boolean;
  supported?: boolean;
  order?: number;
  workbench?: unknown;
};

function descriptorFromPlugin(
  pluginId: string,
  manifest: PluginManifest,
): EngineDescriptor | null {
  const form = manifest.contributes.ui?.connectionForm;
  if (!form || typeof form !== "object") return null;
  const parsed = form as PluginConnectionForm;
  const id = (parsed.engineKey ?? "").trim().toLowerCase();
  if (!id) return null;
  const workbench =
    parseEngineWorkbench(manifest.contributes.ui?.workbench) ??
    parseEngineWorkbench(parsed.workbench) ??
    SQL_WORKBENCH;
  return {
    id,
    pluginId,
    aliases: parsed.aliases?.length ? parsed.aliases.map((a) => a.toLowerCase()) : [id],
    defaultPort: parsed.defaultPort ?? 0,
    icon: parsed.icon ?? id.slice(0, 2).toUpperCase(),
    builtinLayout: parsed.builtinLayout === true,
    supported: parsed.supported !== false,
    order: typeof parsed.order === "number" ? parsed.order : 1000,
    form: { fields: parsed.fields ?? [{ key: "host", type: "text" }, { key: "port", type: "number" }] },
    workbench,
  };
}

function pluginEngineKeys(): Set<string> {
  const keys = new Set<string>();
  for (const manifest of listPluginManifests("engine")) {
    const form = manifest.contributes.ui?.connectionForm;
    if (!form || typeof form !== "object") continue;
    const parsed = form as PluginConnectionForm;
    const id = (parsed.engineKey ?? "").trim().toLowerCase();
    if (id) keys.add(id);
    for (const alias of parsed.aliases ?? []) keys.add(alias.toLowerCase());
  }
  return keys;
}

const FIRST_PARTY_ENGINE_IDS = new Set(
  FIRST_PARTY_PLUGIN_MANIFESTS.filter((m) => m.kind === "engine").map((m) => m.id),
);

function descriptorsFromEnginePlugins(): EngineDescriptor[] {
  const hydrated = usePluginRuntimeStore.getState().hydrated;
  const out: EngineDescriptor[] = [];
  for (const manifest of listPluginManifests("engine")) {
    if (
      hydrated &&
      !isPluginActivated(manifest.id) &&
      !FIRST_PARTY_ENGINE_IDS.has(manifest.id)
    ) {
      continue;
    }
    const desc = descriptorFromPlugin(manifest.id, manifest);
    if (desc) out.push(desc);
  }
  return out;
}

const extraPlugins = new Map<string, EngineDescriptor>();

export function registerEngineDescriptor(descriptor: EngineDescriptor): void {
  extraPlugins.set(descriptor.id, descriptor);
}

export function listEngineDescriptors(): EngineDescriptor[] {
  const merged = new Map<string, EngineDescriptor>();
  for (const item of descriptorsFromEnginePlugins()) merged.set(item.id, item);
  for (const item of extraPlugins.values()) merged.set(item.id, item);
  return [...merged.values()].sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.id.localeCompare(b.id);
  });
}

export function resolveEngineKey(raw: string | null | undefined): string | null {
  const normalized = (raw ?? "").trim().toLowerCase();
  if (!normalized) return null;
  for (const item of listEngineDescriptors()) {
    if (item.id === normalized || item.aliases.includes(normalized)) {
      return item.id;
    }
  }
  return normalized;
}

export function getEngineDescriptor(raw: string | null | undefined): EngineDescriptor | null {
  const key = resolveEngineKey(raw);
  if (!key) return null;
  return listEngineDescriptors().find((item) => item.id === key) ?? null;
}

/** Host 按贡献选择树/编辑器/预览。插件禁用后对应引擎返回 unavailable。 */
export function getEngineWorkbench(raw: string | null | undefined): EngineWorkbench {
  const desc = getEngineDescriptor(raw);
  if (desc) return desc.workbench;
  const key = (raw ?? "").trim().toLowerCase();
  if (key && pluginEngineKeys().has(key)) return UNAVAILABLE_WORKBENCH;
  return SQL_WORKBENCH;
}

export function defaultPortForEngine(engine: string): number {
  return getEngineDescriptor(engine)?.defaultPort ?? 3306;
}

export function isRegisteredEngine(engine: string): boolean {
  const desc = getEngineDescriptor(engine);
  return Boolean(desc?.supported);
}

/** 工作台能用：已激活，或第一方引擎尚未 hydrate 时按可用处理。 */
export function isEngineReady(raw: string | null | undefined): boolean {
  const desc = getEngineDescriptor(raw);
  if (!desc?.pluginId) return false;
  if (FIRST_PARTY_ENGINE_IDS.has(desc.pluginId)) {
    const item = usePluginRuntimeStore.getState().items.find((entry) => entry.id === desc.pluginId);
    if (!item) return true;
    return Boolean(item.enabled && item.activated);
  }
  return isPluginActivated(desc.pluginId);
}
