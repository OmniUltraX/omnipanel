/**
 * 子会话请求上下文继承。
 *
 * 子会话创建时已拷贝父会话的 workspace / terminal / agent，
 * 但 runSingleChild 仍需在发起 ai_chat 时重注入 live append（终端缓冲区、模块现场），
 * 否则子 Agent 看不到父会话当时的运行环境。
 */
import type { AiConversation } from "../../../stores/aiStore";
import { getModuleAiContextText } from "../context";
import type { AiContextBundle } from "../orchestrator";
import {
  resolveTerminalAiContextBundle,
  terminalAiBundleToOrchestratorContext,
} from "../../../modules/terminal/terminalAiContextBundle";
import { resolveChildContextIds } from "./childContextIds";

export { resolveChildContextIds } from "./childContextIds";
export type { ChildContextIdInput, ChildContextIds } from "./childContextIds";

/**
 * 从父子会话 + spawn 规格构建子会话 AiContextBundle。
 * 终端 / 模块 append 取 live 现场；标识字段走继承规则。
 */
export function buildChildAiContextBundle(options: {
  parent: AiConversation | null | undefined;
  child: AiConversation;
  spawnResourceId?: string | null;
}): AiContextBundle {
  const { parent, child, spawnResourceId } = options;
  const ids = resolveChildContextIds({
    parentWorkspaceId: parent?.pinnedWorkspaceId ?? null,
    childWorkspaceId: child.pinnedWorkspaceId ?? null,
    childTerminalSessionId: child.linkedTerminalSessionId ?? null,
    childAgentId: child.agentId,
    spawnResourceId,
    parentResourceId: parent?.contextSnapshot?.activeResource?.id ?? null,
    parentEnvTag: parent?.contextSnapshot?.environment ?? null,
  });

  let terminalFields: AiContextBundle = {
    cwd: null,
    workspaceId: ids.workspaceId,
    terminalSessionId: ids.terminalSessionId,
    terminalSessionType: null,
    envTag: ids.envTag,
    resourceId: ids.resourceId,
    terminalContextAppend: null,
    moduleContextAppend: null,
  };

  if (ids.terminalSessionId) {
    const bundle = resolveTerminalAiContextBundle(ids.terminalSessionId, "assistant");
    if (bundle) {
      terminalFields = {
        ...terminalAiBundleToOrchestratorContext(bundle),
        workspaceId: ids.workspaceId,
        envTag: ids.envTag,
        // spawn 显式 resource 优先于终端 pane 绑定
        resourceId: ids.resourceId ?? bundle.terminalResourceId,
      };
    }
  }

  let moduleContextAppend: string | null = null;
  if (ids.moduleKeyForAppend) {
    try {
      moduleContextAppend = getModuleAiContextText(ids.moduleKeyForAppend);
    } catch {
      moduleContextAppend = null;
    }
  }

  return {
    ...terminalFields,
    moduleContextAppend,
  };
}
