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

export type ResolvedBackend = { kind: "cli" } & ResolvedCliBackend;

export function isCliBackendId(backendId: string): boolean {
  return backendId.startsWith("cli:");
}

export function isStructuredBackendId(id: string): boolean {
  return isCliBackendId(id);
}

/** 构建 `cli:{providerId}::{modelName}` backend_id。 */
export function buildCliBackendId(providerId: string, modelName: string): string {
  return `cli:${providerId}::${modelName}`;
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

/** 解析选择项；仅支持 `cli:` 智能体。 */
export function resolveBackendFromSelection(
  _providers: unknown,
  selectionId: string | null | undefined,
): ResolvedBackend | null {
  if (!selectionId || !isCliBackendId(selectionId)) return null;
  const parsed = parseCliBackendId(selectionId);
  if (!parsed) return null;
  return {
    kind: "cli",
    backendId: selectionId,
    providerId: parsed.providerId,
    modelId: parsed.modelId,
  };
}

/** 第一个已启用且已安装的 CLI 智能体选择 ID。 */
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
    return buildCliBackendId(provider.id, models[0]!);
  }
  return null;
}
