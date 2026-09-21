import {
  getCliProviderModels,
  isCliModelEnabled,
  useCliProvidersStore,
} from "../../stores/cliProvidersStore";

export interface ResolvedCliBackend {
  backendId: string;
  providerId: string;
  modelId: string;
}

export interface ResolvedOpenCodeBackend {
  backendId: string;
  /** LLM providerID（如 opencode、opencode-go） */
  providerId: string;
  modelId: string;
}

export type ResolvedBackend =
  | ({ kind: "cli" } & ResolvedCliBackend)
  | ({ kind: "opencode" } & ResolvedOpenCodeBackend);

export function isCliBackendId(backendId: string): boolean {
  return backendId.startsWith("cli:");
}

export function isOpenCodeBackendId(backendId: string): boolean {
  return backendId.startsWith("opencode:");
}

export function isStructuredBackendId(id: string): boolean {
  return isCliBackendId(id) || isOpenCodeBackendId(id);
}

/** 构建 `cli:{providerId}::{modelName}` backend_id。 */
export function buildCliBackendId(providerId: string, modelName: string): string {
  return `cli:${providerId}::${modelName}`;
}

/** OpenCode 发现缓存条目：`{provider}/{modelId}\u001f{displayName}`。 */
export function parseOpenCodeModelEntry(raw: string): { id: string; label: string } {
  const sep = raw.indexOf("\u001f");
  if (sep < 0) return { id: raw, label: raw };
  const id = raw.slice(0, sep);
  const label = raw.slice(sep + 1).trim() || id;
  return { id, label };
}

/** 构建 `opencode:{providerId}/{modelId}`；model 可为缓存条目、`provider/model` 或纯 modelId。 */
export function buildOpenCodeBackendId(modelKey: string, fallbackProvider = "opencode"): string {
  const trimmed = parseOpenCodeModelEntry(modelKey).id.trim();
  if (!trimmed) return `opencode:${fallbackProvider}/default`;
  if (trimmed.includes("/")) {
    const slash = trimmed.indexOf("/");
    return `opencode:${trimmed.slice(0, slash)}/${trimmed.slice(slash + 1)}`;
  }
  return `opencode:${fallbackProvider}/${trimmed}`;
}

export function parseCliBackendId(backendId: string): { providerId: string; modelId: string } | null {
  if (!isCliBackendId(backendId)) return null;
  const rest = backendId.slice("cli:".length);
  const sep = rest.lastIndexOf("::");
  if (sep < 0) return null;
  return {
    providerId: rest.slice(0, sep),
    modelId: rest.slice(sep + 2),
  };
}

export function parseOpenCodeBackendId(
  backendId: string,
): { providerId: string; modelId: string } | null {
  if (!isOpenCodeBackendId(backendId)) return null;
  const rest = backendId.slice("opencode:".length);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  const providerId = rest.slice(0, slash).trim();
  const modelId = rest.slice(slash + 1).trim();
  if (!providerId || !modelId) return null;
  return { providerId, modelId };
}

/** 解析选择项：`cli:` 或 `opencode:`。 */
export function resolveBackendFromSelection(
  _providers: unknown,
  selectionId: string | null | undefined,
): ResolvedBackend | null {
  if (!selectionId) return null;
  if (isOpenCodeBackendId(selectionId)) {
    const parsed = parseOpenCodeBackendId(selectionId);
    if (!parsed) return null;
    return {
      kind: "opencode",
      backendId: selectionId,
      providerId: parsed.providerId,
      modelId: parsed.modelId,
    };
  }
  if (!isCliBackendId(selectionId)) return null;
  const parsed = parseCliBackendId(selectionId);
  if (!parsed) return null;
  return {
    kind: "cli",
    backendId: selectionId,
    providerId: parsed.providerId,
    modelId: parsed.modelId,
  };
}

/** 当前启用智能体的第一个模型选择 ID（OpenCode → opencode:，其它 → cli:）。 */
export function firstCliSelectionId(): string | null {
  const { providers, modelCache } = useCliProvidersStore.getState();
  for (const provider of providers) {
    if (!provider.enabled) continue;
    if (!provider.binary?.trim()) continue;
    let models = getCliProviderModels(provider, modelCache).filter((name) =>
      isCliModelEnabled(provider, name),
    );
    if (models.length === 0) {
      models = ["default"];
    }
    const model = models[0]!;
    if (provider.id === "opencode") {
      return buildOpenCodeBackendId(model);
    }
    return buildCliBackendId(provider.id, model);
  }
  return null;
}
