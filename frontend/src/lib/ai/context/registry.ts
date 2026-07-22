import { create } from "zustand";

import type { ModuleKey } from "../../paths";
import { errorToString } from "../../errorToString";
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
      result: errorToString(error),
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

/**
 * 聚合所有已注册 ContextProvider 的 AI 上下文文本。
 *
 * 用于把数据库 / SSH / Docker 等模块的结构化上下文注入 system prompt。
 * - 按.scope 字典序输出，保证稳定。
 * - 跳过传入 `excludeScopes` 的 provider（例如 terminal 已有 terminalContextAppend 单独通道）。
 * - 任意 provider 返回 null/空字符串都不输出对应段落。
 * - 返回 null 表示无可注入内容，调用方据此把字段置 null。
 */
export function collectAllModuleAiContextText(
  excludeScopes: string[] = [],
): string | null {
  const excludeSet = new Set(excludeScopes);
  const segments: string[] = [];
  const scopes = Array.from(providers.keys())
    .filter((scope) => !excludeSet.has(scope))
    .sort();
  for (const scope of scopes) {
    const provider = providers.get(scope);
    if (!provider) continue;
    const text = provider.getAiContextText();
    if (text && text.trim().length > 0) {
      segments.push(text);
    }
  }
  if (segments.length === 0) return null;
  return segments.join("\n\n---\n\n");
}
