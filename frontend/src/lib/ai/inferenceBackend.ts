import {
  parseModelSelectionId,
  resolveModelSelection,
  type AiModelProvider,
} from "../../stores/aiModelsStore";
import { useAgentSourcesStore } from "../../stores/agentSourcesStore";

export interface HttpProviderSnapshot {
  providerId: string;
  apiStandard: string;
  baseUrl: string;
  apiKey: string;
}

export interface ResolvedHttpBackend {
  backendId: string;
  httpProvider: HttpProviderSnapshot;
}

export type ResolvedBackend = { kind: "http" } & ResolvedHttpBackend;

export function isStructuredBackendId(id: string): boolean {
  return id.startsWith("http:");
}

/** 构建 `http:{providerId}::{modelName}` backend_id。 */
export function buildHttpBackendId(providerId: string, modelName: string): string {
  return `http:${providerId}::${modelName}`;
}

export function resolveHttpBackendFromSelection(
  providers: AiModelProvider[],
  selectionId: string | null | undefined,
): ResolvedHttpBackend | null {
  if (!selectionId) return null;
  const parsed = parseModelSelectionId(selectionId);
  if (!parsed) return null;
  const resolved = resolveModelSelection(providers, selectionId);
  if (!resolved) return null;

  return {
    backendId: buildHttpBackendId(parsed.providerId, parsed.modelName),
    httpProvider: {
      providerId: parsed.providerId,
      apiStandard: resolved.apiStandard,
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
    },
  };
}

function resolveAgentHttpBackend(selectionId: string): ResolvedHttpBackend | null {
  const parsed = parseModelSelectionId(selectionId);
  if (!parsed) return null;
  const source = useAgentSourcesStore
    .getState()
    .sources.find((item) => item.signedIn && item.id === parsed.providerId);
  if (!source || !source.models.some((model) => model.id === parsed.modelName)) return null;
  return {
    backendId: buildHttpBackendId(parsed.providerId, parsed.modelName),
    httpProvider: {
      providerId: parsed.providerId,
      apiStandard: "openai",
      baseUrl: "https://copilot.tencent.com",
      apiKey: "",
    },
  };
}

export function resolveBackendFromSelection(
  providers: AiModelProvider[],
  selectionId: string | null | undefined,
): ResolvedBackend | null {
  if (!selectionId) return null;
  const http = resolveHttpBackendFromSelection(providers, selectionId);
  if (http) return { kind: "http", ...http };
  const agent = resolveAgentHttpBackend(selectionId);
  if (agent) return { kind: "http", ...agent };
  return null;
}
