import { create } from "zustand";

import type { ModuleKey } from "../../paths";
import { parseToolArguments } from "../parseToolArguments";
import type { ContextProvider } from "./ContextProvider";
import { getModuleMcpToolsFromCatalog } from "./moduleMcpCatalog";
import { isMcpToolAvailable } from "../../../stores/mcpToolStore";
import { isModuleOpen } from "../../../stores/appModuleStore";
import type { AiContextScope, McpToolRegistration } from "./types";

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

export function getModuleMcpTools(moduleKey: ModuleKey): McpToolRegistration[] {
  if (!isModuleOpen(moduleKey)) {
    return [];
  }
  return getModuleMcpToolsFromCatalog(moduleKey).filter((tool) =>
    isMcpToolAvailable(tool.name),
  );
}

export async function executeModuleMcpTool(
  moduleKey: ModuleKey,
  toolName: string,
  toolArguments: string,
): Promise<{ result: string; success: boolean }> {
  if (!isMcpToolAvailable(toolName)) {
    return { result: `MCP 工具不可用：${toolName}`, success: false };
  }
  const tool = getModuleMcpToolsFromCatalog(moduleKey).find((item) => item.name === toolName);
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

export function getWorkspaceAiContextText(workspaceId: string): string | null {
  const provider = getContextProvider(`workspace:${workspaceId}`);
  return provider?.getAiContextText() ?? null;
}

/** 按 scope 字符串（如 module:database）读取 AI 上下文文本 */
export function getAiContextTextForScope(scope: string): string | null {
  const provider = providers.get(scope as AiContextScope);
  return provider?.getAiContextText() ?? null;
}
