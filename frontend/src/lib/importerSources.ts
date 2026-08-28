import type { ImporterField } from "@omnipanel/plugin-sdk";
import { commands } from "../ipc/bindings";
import { unwrapCommand } from "../ipc/result";
import { secretKeyFor } from "./importerCatalog";

export type ImporterAuthMode = "password" | "key";

export type ImporterSource = {
  id: string;
  name: string;
  values: Record<string, string>;
  secretKeys: Record<string, string>;
  authMode?: ImporterAuthMode;
  keyId?: string;
  updatedAt: number;
};

export type ImporterPluginState = {
  sources: ImporterSource[];
};

export function newImporterSourceId(): string {
  return `imp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function asRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

/** 兼容第一版 Warpgate 扁平字段，避免已保存实例丢失。 */
function normalizeSource(raw: unknown): ImporterSource | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== "string") return null;
  if (item.values && typeof item.values === "object") {
    return {
      id: item.id,
      name: typeof item.name === "string" ? item.name : "",
      values: asRecord(item.values),
      secretKeys: asRecord(item.secretKeys),
      authMode: item.authMode === "key" ? "key" : "password",
      keyId: typeof item.keyId === "string" && item.keyId.trim() ? item.keyId : undefined,
      updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : Date.now(),
    };
  }
  if (typeof item.baseUrl !== "string" || typeof item.tokenKey !== "string") return null;
  return {
    id: item.id,
    name: typeof item.name === "string" ? item.name : "",
    values: {
      name: typeof item.name === "string" ? item.name : "",
      baseUrl: item.baseUrl,
      loginUser: typeof item.loginUser === "string" ? item.loginUser : "",
    },
    secretKeys: {
      token: item.tokenKey,
      password: typeof item.loginPasswordKey === "string" ? item.loginPasswordKey : `login-${item.id}`,
    },
    authMode: item.authMode === "key" ? "key" : "password",
    keyId: typeof item.keyId === "string" && item.keyId.trim() ? item.keyId : undefined,
    updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : Date.now(),
  };
}

export async function loadImporterState(pluginId: string): Promise<ImporterPluginState> {
  const raw = await unwrapCommand(commands.pluginStateGet(pluginId));
  try {
    const parsed = JSON.parse(raw) as { sources?: unknown[] };
    const sources = Array.isArray(parsed.sources)
      ? parsed.sources.map(normalizeSource).filter((item): item is ImporterSource => item !== null)
      : [];
    return { sources };
  } catch {
    return { sources: [] };
  }
}

export async function saveImporterState(pluginId: string, state: ImporterPluginState): Promise<void> {
  await unwrapCommand(commands.pluginStateSet(pluginId, JSON.stringify(state)));
}

export async function upsertImporterSource(
  pluginId: string,
  fields: ImporterField[],
  input: {
    id?: string;
    name: string;
    values: Record<string, string>;
    secrets: Record<string, string>;
    authMode?: ImporterAuthMode;
    keyId?: string;
  },
): Promise<ImporterSource> {
  const state = await loadImporterState(pluginId);
  const id = input.id?.trim() || newImporterSourceId();
  const existing = state.sources.find((item) => item.id === id);
  const secretKeys: Record<string, string> = { ...(existing?.secretKeys ?? {}) };
  for (const field of fields) {
    if (field.kind !== "secret") continue;
    const vaultKey = secretKeyFor(field, id);
    secretKeys[field.key] = vaultKey;
    const fresh = input.secrets[field.key]?.trim();
    if (fresh) {
      await unwrapCommand(commands.pluginSecretPut(pluginId, vaultKey, fresh));
    } else if (field.required && !existing) {
      throw new Error(`请填写${field.label}`);
    }
  }
  const values: Record<string, string> = {};
  for (const field of fields) {
    if (field.kind === "secret") continue;
    values[field.key] = (input.values[field.key] ?? "").trim();
  }
  const next: ImporterSource = {
    id,
    name: input.name.trim() || hostLabel(values.baseUrl || values.name || id),
    values,
    secretKeys,
    authMode: input.authMode ?? existing?.authMode ?? "password",
    keyId: (input.keyId ?? existing?.keyId)?.trim() || undefined,
    updatedAt: Date.now(),
  };
  const sources = existing
    ? state.sources.map((item) => (item.id === id ? next : item))
    : [...state.sources, next];
  await saveImporterState(pluginId, { sources });
  return next;
}

export async function deleteImporterSource(pluginId: string, id: string): Promise<void> {
  const state = await loadImporterState(pluginId);
  const target = state.sources.find((item) => item.id === id);
  if (target) {
    for (const key of Object.values(target.secretKeys)) {
      await unwrapCommand(commands.pluginSecretDelete(pluginId, key)).catch(() => undefined);
    }
  }
  await saveImporterState(pluginId, { sources: state.sources.filter((item) => item.id !== id) });
}

export async function readImporterSecret(
  pluginId: string,
  source: ImporterSource,
  fieldKey: string,
): Promise<string> {
  const vaultKey = source.secretKeys[fieldKey];
  if (!vaultKey) return "";
  try {
    return await unwrapCommand(commands.pluginSecretGet(pluginId, vaultKey));
  } catch {
    return "";
  }
}

function hostLabel(value: string): string {
  try {
    return new URL(value).host || value;
  } catch {
    return value;
  }
}
