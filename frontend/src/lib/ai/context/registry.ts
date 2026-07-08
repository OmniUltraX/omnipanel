import { create } from "zustand";

import type { ModuleKey } from "../../paths";
import { parseToolArguments } from "../parseToolArguments";
import type { ContextProvider } from "./ContextProvider";
import { getModuleBuiltinToolsFromCatalog } from "./moduleBuiltinCatalog";
import { isBuiltinToolAvailable } from "../../../stores/builtinToolStore";
import { isModuleOpen } from "../../../stores/appModuleStore";
import type { AiContextScope, BuiltinToolRegistration } from "./types";

const providers = new Map<AiContextScope, ContextProvider>();

interface AiContextRegistryState {
  revision: number;
}

export const useAiContextRegistry = create<AiContextRegistryState>(() => ({
  revision: 0,
}));

export function touchAiContextRegistry(): void {
  useAiContextRegistry.setState((state) => ({ revision: state.revision + 1 }));
}

export function registerContextProvider(provider: ContextProvider): void {
  providers.set(provider.scope, provider);
  touchAiContextRegistry();
}

export function unregisterContextProvider(scope: AiContextScope): void {
  providers.delete(scope);
  touchAiContextRegistry();
}

export function updateRegisteredProviderContext<TContext>(
  provider: ContextProvider<TContext>,
  context: TContext | null,
): void {
  provider.updateContext(context);
  if (providers.has(provider.scope)) {
    touchAiContextRegistry();
  }
}

export function getContextProvider(scope: AiContextScope): ContextProvider | undefined {
  return providers.get(scope);
}

export function getModuleContextProvider(
  moduleKey: ModuleKey,
): ContextProvider | undefined {
  return providers.get(`module:${moduleKey}`);
}

export function getModuleAiContextText(moduleKey: ModuleKey): string | null {
  const provider = getModuleContextProvider(moduleKey);
  return provider?.getAiContextText() ?? null;
}

export function getModuleBuiltinTools(moduleKey: ModuleKey): BuiltinToolRegistration[] {
  if (!isModuleOpen(moduleKey)) {
    return [];
  }
  return getModuleBuiltinToolsFromCatalog(moduleKey).filter((tool) =>
    isBuiltinToolAvailable(tool.name),
  );
}

/** @deprecated 使用 getModuleBuiltinTools */
export const getModuleMcpTools = getModuleBuiltinTools;

export async function executeModuleBuiltinTool(
  moduleKey: ModuleKey,
  toolName: string,
  toolArguments: string,
): Promise<{ result: string; success: boolean }> {
  if (!isBuiltinToolAvailable(toolName)) {
    return { result: `内置工具不可用：${toolName}`, success: false };
  }
  const tool = getModuleBuiltinToolsFromCatalog(moduleKey).find((item) => item.name === toolName);
  if (!tool) {
    return { result: `未找到模块工具：${toolName}`, success: false };
  }
  try {
    const args = parseToolArguments(toolArguments);
    const result = await tool.handler(args);
    return { result, success: true };
  } catch (error) {
    return {
      result: error instanceof Error ? error.message : String(error),
      success: false,
    };
  }
}

/** @deprecated 使用 executeModuleBuiltinTool */
export const executeModuleMcpTool = executeModuleBuiltinTool;

export function getWorkspaceAiContextText(workspaceId: string): string | null {
  const provider = getContextProvider(`workspace:${workspaceId}`);
  return provider?.getAiContextText() ?? null;
}

/** 按 scope 字符串（如 module:database）读取 AI 上下文文本 */
export function getAiContextTextForScope(scope: string): string | null {
  const provider = providers.get(scope as AiContextScope);
  return provider?.getAiContextText() ?? null;
}
