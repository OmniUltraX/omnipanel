import { ContextProvider, type WorkspaceContextScope } from "./ContextProvider";
import { registerContextProvider, unregisterContextProvider } from "./registry";

/** 工程工作区的 AI 上下文提供者基类（预留） */
export abstract class WorkspaceContextProvider<
  TContext = unknown,
> extends ContextProvider<TContext> {
  readonly workspaceId: string;
  readonly scope: WorkspaceContextScope;

  constructor(workspaceId: string) {
    super();
    this.workspaceId = workspaceId;
    this.scope = `workspace:${workspaceId}`;
  }
}

/** 挂载工作区 ContextProvider，卸载时自动 dispose */
export function mountWorkspaceContextProvider(
  provider: WorkspaceContextProvider,
): () => void {
  registerContextProvider(provider);
  return () => {
    unregisterContextProvider(provider.scope);
    provider.dispose();
  };
}
