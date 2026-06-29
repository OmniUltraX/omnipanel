import type { AiContextScope } from "./types";

/**
 * 模块与工作区向 AI 助手暴露上下文的基类。
 * 子类负责格式化上下文文本；MCP 工具在 moduleMcpCatalog 中统一注册。
 */
export abstract class ContextProvider<TContext = unknown> {
  abstract readonly scope: AiContextScope;

  protected context: TContext | null = null;

  updateContext(context: TContext | null): void {
    this.context = context;
  }

  getContext(): TContext | null {
    return this.context;
  }

  /** 将结构化上下文格式化为 AI 可读的文本片段 */
  abstract formatContextForAi(context: TContext): string;

  getAiContextText(): string | null {
    if (this.context == null) {
      return null;
    }
    const text = this.formatContextForAi(this.context).trim();
    return text.length > 0 ? text : null;
  }

  dispose(): void {
    this.context = null;
  }
}

export type { AiContextScope, McpToolRegistration, ModuleContextScope, WorkspaceContextScope } from "./types";
