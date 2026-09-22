import { useCallback, useEffect, useMemo, useState } from "react";

import { commands, type BackendInfo, type CliProviderRecord } from "../../ipc/bindings";
import { canUseAiBackend } from "../isTauriRuntime";
import type { AiModelProvider } from "../../stores/aiModelsStore";
import {
  getCliProviderModels,
  isCliModelEnabled,
  useCliProvidersStore,
} from "../../stores/cliProvidersStore";
import { buildCliBackendId, buildOpenCodeBackendId, parseOpenCodeModelEntry } from "./inferenceBackend";

export interface BackendSelectOption {
  value: string;
  label: string;
  subtitle?: string;
  group: "cli" | "opencode";
  installed?: boolean;
}

/** 从智能体 store 构造选择项（与设置页模型列表同源；同时只应有一个启用）。 */
export function buildCliOptionsFromProviders(
  cliProviders: CliProviderRecord[],
  modelCache: Record<string, string[]>,
): BackendSelectOption[] {
  const options: BackendSelectOption[] = [];
  // 单智能体互斥：只取当前启用者（若历史遗留多个，取第一个）
  const active = cliProviders
    .filter((p) => p.enabled && Boolean(p.binary?.trim()))
    .slice(0, 1);
  for (const provider of active) {
    let models = getCliProviderModels(provider, modelCache).filter((name) =>
      isCliModelEnabled(provider, name),
    );
    // 已启用但尚未拉到模型时仍露出 default，避免选择器为空
    if (models.length === 0) {
      models = ["default"];
    }

    const isOpenCode = provider.id === "opencode";
    for (const model of models) {
      if (isOpenCode) {
        const { label } = parseOpenCodeModelEntry(model);
        options.push({
          value: buildOpenCodeBackendId(model),
          label,
          group: "opencode",
          installed: true,
        });
      } else {
        options.push({
          value: buildCliBackendId(provider.id, model),
          label: `${provider.displayName}/${model}`,
          group: "cli",
          installed: true,
        });
      }
    }
  }
  return options;
}

function mergeBackendOptions(
  primary: BackendSelectOption[],
  secondary: BackendSelectOption[],
): BackendSelectOption[] {
  const seen = new Set(primary.map((o) => o.value));
  const merged = [...primary];
  for (const opt of secondary) {
    if (seen.has(opt.value)) continue;
    seen.add(opt.value);
    merged.push(opt);
  }
  return merged;
}

export function buildBackendSelectOptions(
  _providers: AiModelProvider[],
  extraBackends: BackendInfo[] = [],
  cliProviders: CliProviderRecord[] = [],
  modelCache: Record<string, string[]> = {},
): BackendSelectOption[] {
  const fromStore = buildCliOptionsFromProviders(cliProviders, modelCache);

  const fromApi: BackendSelectOption[] = extraBackends
    .filter((b) => b.kind === "cli" || b.kind === "opencode")
    .map((b) => ({
      value: b.id,
      label: b.label,
      subtitle: b.kind === "opencode" ? "OpenCode" : b.installed ? "智能体" : "未安装",
      group: (b.kind === "opencode" ? "opencode" : "cli") as "cli" | "opencode",
      installed: b.installed,
    }));

  // store 优先（与设置页开关/禁用模型一致），API 补缺
  return mergeBackendOptions(fromStore, fromApi);
}

async function fetchAgentBackends(): Promise<BackendInfo[]> {
  if (!canUseAiBackend()) return [];
  try {
    const res = await commands.aiListBackends();
    if (res.status !== "ok") return [];
    return res.data.filter((b) => b.kind === "cli" || b.kind === "opencode");
  } catch {
    return [];
  }
}

export function useBackendSelectOptions(providers: AiModelProvider[]) {
  const cliProviders = useCliProvidersStore((s) => s.providers);
  const cliModelCache = useCliProvidersStore((s) => s.modelCache);
  const syncProviders = useCliProvidersStore((s) => s.syncProviders);
  const [extraBackends, setExtraBackends] = useState<BackendInfo[]>([]);

  const refreshBackends = useCallback(async () => {
    const backends = await fetchAgentBackends();
    setExtraBackends(backends);
  }, []);

  useEffect(() => {
    if (!canUseAiBackend()) return;
    // 与设置页同源：先同步智能体与模型缓存，再拉 API 补缺
    void syncProviders().finally(() => {
      void refreshBackends();
    });
  }, [syncProviders, refreshBackends]);

  useEffect(() => {
    void refreshBackends();
  }, [cliProviders, cliModelCache, refreshBackends]);

  return useMemo(
    () => buildBackendSelectOptions(providers, extraBackends, cliProviders, cliModelCache),
    [providers, extraBackends, cliProviders, cliModelCache],
  );
}
