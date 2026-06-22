import type { ModuleKey } from "../../paths";
import { ContextProvider, type ModuleContextScope } from "./ContextProvider";
import { registerContextProvider, unregisterContextProvider } from "./registry";

/** 功能模块（终端、数据库、Docker 等）的 AI 上下文提供者基类 */
export abstract class ModuleContextProvider<
  TContext = unknown,
> extends ContextProvider<TContext> {
  readonly moduleKey: ModuleKey;
  readonly scope: ModuleContextScope;

  constructor(moduleKey: ModuleKey) {
    super();
    this.moduleKey = moduleKey;
    this.scope = `module:${moduleKey}`;
  }
}

/** 挂载模块 ContextProvider，卸载时自动 dispose */
export function mountModuleContextProvider(provider: ModuleContextProvider): () => void {
  registerContextProvider(provider);
  return () => {
    unregisterContextProvider(provider.scope);
    provider.dispose();
  };
}
