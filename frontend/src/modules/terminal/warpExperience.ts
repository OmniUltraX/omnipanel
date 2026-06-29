import { commands } from "../../ipc/bindings";
import { useAiStore } from "../../stores/aiStore";
import { submitAiPrompt } from "../../lib/ai/submitAiPrompt";
import type { TerminalBlock } from "../../stores/blocksStore";

export function openAiWithPrompt(prompt: string): void {
  useAiStore.getState().openDrawer();
  void submitAiPrompt(prompt, {
    newConversation: true,
    contextChips: [{ type: "terminal", label: "终端" }],
  });
}

export function buildExplainErrorPrompt(block: TerminalBlock): string {
  return `解释以下终端错误并给出修复建议：\n\n命令：\`${block.command}\`\n退出码：${block.exitCode}\n\n输出：\n\`\`\`\n${block.output.slice(-1500)}\n\`\`\``;
}

export function buildFixErrorPrompt(block: TerminalBlock): string {
  return `修复以下终端错误，给出可直接执行的命令：\n\n命令：\`${block.command}\`\n退出码：${block.exitCode}\n\n输出：\n\`\`\`\n${block.output.slice(-1500)}\n\`\`\``;
}

export function buildNaturalLanguagePrompt(query: string, cwd?: string): string {
  const cwdLine = cwd ? `\n当前目录：${cwd}` : "";
  return `${query}${cwdLine}\n\n请结合当前终端上下文，给出可执行的 shell 命令并简要说明；若需执行请使用 omni_terminal_run_terminal_command 工具。`;
}

export interface CommandPlanStep {
  title: string;
  command: string;
}

export function buildCommandPlanPrompt(goal: string, cwd?: string): string {
  const cwdLine = cwd ? `\n当前目录：${cwd}` : "";
  return `请把以下目标拆成 3-6 步终端命令计划，每步一行，格式为「步骤标题 | 命令」：${cwdLine}\n\n目标：${goal}`;
}

export async function saveCommandsAsWorkflow(name: string, shellCommands: string[], target: string): Promise<string> {
  const steps = shellCommands.map((command, index) => ({
    id: null,
    name: `步骤 ${index + 1}`,
    description: command,
    step_type: "shell" as const,
    command,
    step_order: index,
  }));
  const res = await commands.workflowSave({
    id: null,
    name,
    description: "由终端 Command Bar 保存",
    workflow_type: "script",
    risk_level: "medium",
    target,
    env_tag: "dev",
    steps,
  });
  if (res.status !== "ok") {
    throw new Error(res.error.message);
  }
  return res.data.workflow.id;
}
