import { useMemo } from "react";

import type { AiModelProvider } from "../../stores/aiModelsStore";
import { listModelSelections, parseModelSelectionId, buildModelSelectionId } from "../../stores/aiModelsStore";
import { isAgentModelEnabled, useAgentSourcesStore } from "../../stores/agentSourcesStore";

export interface BackendSelectOption {
  value: string;
  label: string;
  subtitle?: string;
  meta?: string;
  group: "http";
  installed?: boolean;
}

export function buildBackendSelectOptions(
  providers: AiModelProvider[],
): BackendSelectOption[] {
  return listModelSelections(providers).map(({ id }) => {
    const parsed = parseModelSelectionId(id);
    const provider = providers.find((p) => p.id === parsed?.providerId);
    const modelName = parsed?.modelName ?? id;
    const standard = provider?.apiStandard === "anthropic" ? "Anthropic" : "OpenAI";
    return {
      value: id,
      label: modelName,
      subtitle: provider ? `${provider.providerName} · ${standard}` : undefined,
      group: "http" as const,
      installed: true,
    };
  });
}

/** 悬停说明。`$2/$6` 是每百万 token 的输入/输出价。 */
export function modelSelectTitle(label: string, meta?: string, subtitle?: string): string {
  const price = meta?.match(/^\$(.+)\/\$(.+)$/);
  if (price) {
    return [label, `每百万 token 输入 $${price[1]} / 输出 $${price[2]}`, subtitle]
      .filter(Boolean)
      .join(" · ");
  }
  return [label, meta, subtitle].filter(Boolean).join(" · ");
}

export function useBackendSelectOptions(providers: AiModelProvider[]) {
  const agentSources = useAgentSourcesStore((s) => s.sources);
  const agentPrefs = useAgentSourcesStore((s) => s.prefs);

  return useMemo(() => {
    const agentOptions: BackendSelectOption[] = agentSources.flatMap((source) => {
      if (!source.signedIn) return [];
      return source.models
        .filter((model) => isAgentModelEnabled(source.id, model.id))
        .map((model) => ({
          value: buildModelSelectionId(source.id, model.id),
          label: model.name,
          subtitle: source.title,
          meta: model.credits ?? undefined,
          group: "http" as const,
          installed: true,
        }));
    });
    return [...buildBackendSelectOptions(providers), ...agentOptions];
  }, [providers, agentSources, agentPrefs]);
}
