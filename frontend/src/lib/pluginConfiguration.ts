import {
  pluginConfigurationSchema,
  type ImporterField,
  type PluginConfigurationContribution,
  type PluginConfigurationProperty,
  type PluginManifest,
} from "@omnipanel/plugin-sdk";
import { commands } from "../ipc/bindings";
import { unwrapCommand } from "../ipc/result";
import { getPluginManifest } from "./pluginManifests";

const STATE_KEY = "configuration";
const SECRET_PREFIX = "config:";

/**
 * 已安装包可能落后于仓库清单时的宿主回退（避免市场旧包缺 configuration 导致无「设置」）。
 * 新插件仍应在 plugin.json 声明；此处仅补官方已知面板。
 */
const HOST_CONFIGURATION_FALLBACKS: Record<string, PluginConfigurationContribution> = {
  "omni.addon.warpgate": {
    title: "Warpgate",
    panel: "warpgate.gateways",
  },
};

export type PluginSettingsField =
  | {
      source: "property";
      key: string;
      label: string;
      description?: string;
      kind: "text" | "number" | "boolean" | "password" | "enum";
      enumValues?: Array<string | number | boolean>;
      defaultValue?: unknown;
      secret: boolean;
      order: number;
    }
  | {
      source: "field";
      key: string;
      label: string;
      description?: string;
      kind: ImporterField["kind"];
      defaultValue?: string;
      placeholder?: string;
      required?: boolean;
      secret: boolean;
      order: number;
      field: ImporterField;
    };

export type ResolvedPluginConfiguration = {
  title?: string;
  panel?: string;
  fields: PluginSettingsField[];
};

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

export function parsePluginConfiguration(
  raw: unknown,
): PluginConfigurationContribution | null {
  if (raw == null) return null;
  const parsed = pluginConfigurationSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function getPluginConfiguration(
  pluginIdOrManifest: string | PluginManifest | null | undefined,
): PluginConfigurationContribution | null {
  const pluginId =
    typeof pluginIdOrManifest === "string"
      ? pluginIdOrManifest
      : pluginIdOrManifest?.id;
  const manifest =
    typeof pluginIdOrManifest === "string"
      ? getPluginManifest(pluginIdOrManifest)
      : pluginIdOrManifest;
  const fromManifest = manifest?.contributes.configuration ?? null;
  if (fromManifest) {
    // 清单里可能是未过 Zod 的宽松对象（IPC JSON）；再校验一次
    const parsed = parsePluginConfiguration(fromManifest);
    if (parsed) return parsed;
  }
  if (pluginId && HOST_CONFIGURATION_FALLBACKS[pluginId]) {
    return HOST_CONFIGURATION_FALLBACKS[pluginId] ?? null;
  }
  return null;
}

/** 已安装列表始终可点「设置」；无声明时 SubWindow 显示空态。 */
export function pluginHasConfiguration(
  _pluginIdOrManifest?: string | PluginManifest | null,
): boolean {
  return true;
}

export function resolvePluginConfiguration(
  pluginIdOrManifest: string | PluginManifest | null | undefined,
): ResolvedPluginConfiguration | null {
  const config = getPluginConfiguration(pluginIdOrManifest);
  if (!config) return null;

  const fields: PluginSettingsField[] = [];

  if (config.properties) {
    for (const [key, prop] of Object.entries(config.properties)) {
      fields.push(propertyToField(key, prop));
    }
  }

  if (config.fields?.length) {
    config.fields.forEach((field, index) => {
      fields.push({
        source: "field",
        key: field.key,
        label: field.label,
        description: field.savedHint,
        kind: field.kind,
        defaultValue: field.defaultValue,
        placeholder: field.placeholder,
        required: field.required,
        secret: field.kind === "secret",
        order: 1000 + index,
        field,
      });
    });
  }

  fields.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));

  const panel = config.panel?.trim() || undefined;
  if (fields.length === 0 && !panel) return null;

  return {
    title: config.title?.trim() || undefined,
    panel,
    fields,
  };
}

function propertyToField(key: string, prop: PluginConfigurationProperty): PluginSettingsField {
  const secret = Boolean(prop.secret) || prop.format === "password";
  let kind: PluginSettingsField["kind"] = "text";
  if (prop.enum && prop.enum.length > 0) kind = "enum";
  else if (secret) kind = "password";
  else if (prop.type === "number") kind = "number";
  else if (prop.type === "boolean") kind = "boolean";
  return {
    source: "property",
    key,
    label: key,
    description: prop.description,
    kind,
    enumValues: prop.enum,
    defaultValue: prop.default,
    secret,
    order: prop.order ?? 0,
  };
}

export function configSecretKey(propertyKey: string): string {
  return `${SECRET_PREFIX}${propertyKey}`;
}

function defaultString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

export async function loadPluginConfigurationValues(
  pluginId: string,
  resolved: ResolvedPluginConfiguration,
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const field of resolved.fields) {
    values[field.key] = defaultString(field.defaultValue);
  }

  try {
    const raw = await unwrapCommand(commands.pluginStateGet(pluginId));
    const parsed = JSON.parse(raw) as unknown;
    const root = asRecord(parsed);
    const stored = asRecord(root?.[STATE_KEY]) ?? {};
    for (const field of resolved.fields) {
      if (field.secret) continue;
      if (Object.prototype.hasOwnProperty.call(stored, field.key)) {
        values[field.key] = defaultString(stored[field.key]);
      }
    }
  } catch {
    // 无状态时保留默认值
  }

  await Promise.all(
    resolved.fields
      .filter((field) => field.secret)
      .map(async (field) => {
        try {
          const secret = await unwrapCommand(
            commands.pluginSecretGet(pluginId, configSecretKey(field.key)),
          );
          if (secret) values[field.key] = secret;
        } catch {
          // 未存过
        }
      }),
  );

  return values;
}

export async function savePluginConfigurationValues(
  pluginId: string,
  resolved: ResolvedPluginConfiguration,
  values: Record<string, string>,
): Promise<void> {
  let root: Record<string, unknown> = {};
  try {
    const raw = await unwrapCommand(commands.pluginStateGet(pluginId));
    const parsed = JSON.parse(raw) as unknown;
    root = asRecord(parsed) ?? {};
  } catch {
    root = {};
  }

  const nextConfig: Record<string, unknown> = {
    ...(asRecord(root[STATE_KEY]) ?? {}),
  };

  for (const field of resolved.fields) {
    const rawValue = values[field.key] ?? "";
    if (field.secret) {
      if (rawValue.trim()) {
        await unwrapCommand(
          commands.pluginSecretPut(pluginId, configSecretKey(field.key), rawValue),
        );
      }
      delete nextConfig[field.key];
      continue;
    }

    if (field.kind === "boolean" || field.kind === "checkbox") {
      nextConfig[field.key] = rawValue === "true" || rawValue === "1";
    } else if (field.kind === "number") {
      const num = Number(rawValue);
      nextConfig[field.key] = Number.isFinite(num) ? num : rawValue;
    } else {
      nextConfig[field.key] = rawValue;
    }
  }

  root[STATE_KEY] = nextConfig;
  await unwrapCommand(commands.pluginStateSet(pluginId, JSON.stringify(root)));
}
