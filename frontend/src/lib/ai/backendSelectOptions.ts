import { useCallback, useEffect, useMemo, useState } from "react";



import { commands, type BackendInfo } from "../../ipc/bindings";

import { canUseAiBackend } from "../isTauriRuntime";

import {

  listModelSelections,

  parseModelSelectionId,

  type AiModelProvider,

} from "../../stores/aiModelsStore";

import { useCliProvidersStore } from "../../stores/cliProvidersStore";



export interface BackendSelectOption {

  value: string;

  label: string;

  subtitle?: string;

  group: "http" | "cli" | "acp";

  installed?: boolean;

}



export function buildBackendSelectOptions(

  providers: AiModelProvider[],

  extraBackends: BackendInfo[] = [],

): BackendSelectOption[] {

  const httpOptions: BackendSelectOption[] = listModelSelections(providers).map(({ id }) => {

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



  const cliOptions: BackendSelectOption[] = extraBackends

    .filter((b) => b.kind === "cli")

    .map((b) => ({

      value: b.id,

      label: b.label,

      subtitle: b.installed ? "CLI 提供者" : "未安装",

      group: "cli" as const,

      installed: b.installed,

    }));



  const acpOptions: BackendSelectOption[] = extraBackends

    .filter((b) => b.kind === "acp")

    .map((b) => ({

      value: b.id,

      label: b.label,

      subtitle: "遗留 acp 别名",

      group: "acp" as const,

      installed: b.installed,

    }));



  return [...httpOptions, ...cliOptions, ...acpOptions];

}



async function fetchCliBackends(): Promise<BackendInfo[]> {

  if (!canUseAiBackend()) return [];

  const res = await commands.aiListBackends();

  if (res.status !== "ok") return [];

  return res.data.filter((b) => b.kind === "cli" || b.kind === "acp");

}



export function useBackendSelectOptions(providers: AiModelProvider[]) {

  const cliProviders = useCliProvidersStore((s) => s.providers);

  const cliModelCache = useCliProvidersStore((s) => s.modelCache);

  const [extraBackends, setExtraBackends] = useState<BackendInfo[]>([]);



  const refreshBackends = useCallback(async () => {

    const backends = await fetchCliBackends();

    setExtraBackends(backends);

  }, []);



  useEffect(() => {

    void refreshBackends();

  }, [providers, cliProviders, cliModelCache, refreshBackends]);



  return useMemo(

    () => buildBackendSelectOptions(providers, extraBackends),

    [providers, extraBackends],

  );

}


