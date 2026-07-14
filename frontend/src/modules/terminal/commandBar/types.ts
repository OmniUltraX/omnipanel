export type CompletionSource =
  | "history"
  | "command"
  | "path"
  | "resource"
  | "template"
  | "ai";

export type CompletionPriority = "high" | "default" | "low";

export interface ReplacementRange {
  start: number;
  end: number;
}

export interface CompletionCandidate {
  id: string;
  label: string;
  insertText: string;
  description?: string;
  source: CompletionSource;
  priority: CompletionPriority;
  replacement: ReplacementRange;
  /** 来自历史索引时保留时间，用于排序 */
  timestamp?: number;
  /** 历史条目类型（shell / ai / readline） */
  historyKind?: "shell" | "ai" | "readline";
}

export interface TerminalCompletionContext {
  sessionId: string;
  cwd: string;
  input: string;
  cursor: number;
  resourceId: string | null;
  sessionType: "local" | "remote";
}

export interface CompletionProvider {
  id: string;
  suggest: (ctx: TerminalCompletionContext) => CompletionCandidate[] | Promise<CompletionCandidate[]>;
}

export interface ParsedCommandToken {
  text: string;
  start: number;
  end: number;
  kind: "command" | "argument" | "path" | "resource" | "flag";
}

export interface ParsedCommandLine {
  tokens: ParsedCommandToken[];
  activeToken: ParsedCommandToken | null;
}
