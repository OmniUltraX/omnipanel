import { ModuleContextProvider } from "../../../lib/ai/context";
import { collectTerminalContext, formatContextForAI } from "../../../lib/terminalContext";
import { getResourceById } from "../../../lib/resourceRegistry";
import { useSshStatsStore } from "../../../stores/sshStatsStore";
import {
  resolveAiTerminalHints,
  formatAiTerminalHints,
} from "../buildTerminalAiContext";
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

    const lines: string[] = [];

    // 统一使用 resolveAiTerminalHints 生成 OS/Shell/Host 等环境提示
    if (context.session) {
      const resource = context.resource ?? getResourceById(context.session.resourceId);
      const stats = useSshStatsStore.getState().statsMap[context.session.resourceId] ?? null;
      const hints = resolveAiTerminalHints(context.session, resource, stats);
      lines.push(formatAiTerminalHints(hints));
    }

    // 追加最近命令历史与错误信息
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
