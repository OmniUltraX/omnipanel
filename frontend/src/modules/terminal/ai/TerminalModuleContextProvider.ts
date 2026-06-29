import { ModuleContextProvider } from "../../../lib/ai/context";
import { collectTerminalContext, formatContextForAI } from "../../../lib/terminalContext";
import type { TerminalModuleContext } from "./types";
import { isTerminalModuleContextEmpty } from "./types";

export class TerminalModuleContextProvider extends ModuleContextProvider<TerminalModuleContext> {
  constructor() {
    super("terminal");
  }

  formatContextForAi(context: TerminalModuleContext): string {
    if (isTerminalModuleContextEmpty(context) || !context.activeSessionId) {
      return "";
    }

    const lines = ["## 终端模块上下文"];
    if (context.resource) {
      lines.push(`- 资源：${context.resource.name} (${context.resource.type})`);
      lines.push(`- 环境：${context.resource.environment}`);
    }
    if (context.session) {
      lines.push(`- 会话类型：${context.session.type}`);
      lines.push(`- 工作目录：${context.session.cwd || "未知"}`);
      lines.push(`- Shell：${context.session.shellLabel || "默认"}`);
    }

    const terminalCtx = collectTerminalContext(
      context.activeSessionId,
      context.recentBlocks,
      8,
    );
    const formatted = formatContextForAI(terminalCtx);
    if (formatted) lines.push("", formatted);

    return lines.join("\n");
  }
}

export const terminalModuleContextProvider = new TerminalModuleContextProvider();
