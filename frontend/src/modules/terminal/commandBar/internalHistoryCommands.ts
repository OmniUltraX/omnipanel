/** 不应出现在用户可见历史中的内部 / 注入命令 */
const INTERNAL_PATTERNS: RegExp[] = [
  /^__omnipanel_/,
  /^__OMNIPANEL_/,
  /__OMNIPANEL_SHELL_INT/,
  /omnipanel_emit_history/,
  /OmniPanelInit___OMNIPANEL_CWD_HOOK/,
  /^if \[ -z "\$\{__OMNIPANEL_SHELL_INT/,
  /^export __OMNIPANEL_SHELL_INT=/,
  /^__omnipanel_prompt_start\s*\(/,
  /^PROMPT_COMMAND=.*__omnipanel_/,
  /^iex\s*\(\[Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\(/i,
];

export function isInternalHistoryCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return true;
  if (trimmed === "__omnipanel_history_sync__") return true;
  if (trimmed.includes("__OMNIPANEL_HIST_BEGIN__")) return true;
  if (trimmed.includes("__OMNIPANEL_HIST_END__")) return true;
  if (trimmed.includes("HISTFILE") && trimmed.includes("base64")) return true;
  if (trimmed.includes("Get-PSReadLineOption") && trimmed.includes("__OMNIPANEL_HIST_")) return true;
  if (trimmed.includes("HistorySavePath") && trimmed.includes("ToBase64String")) return true;
  return INTERNAL_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** 去重并过滤，保持新 → 旧顺序 */
export function normalizeHistoryCommands(commands: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of commands) {
    const text = raw.trim();
    if (!text || isInternalHistoryCommand(text) || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}
