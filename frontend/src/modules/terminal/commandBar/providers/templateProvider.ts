import type { CompletionCandidate, TerminalCompletionContext } from "../types";
import { buildReplacementRange, parseCommandLineForCompletion } from "../parseCommandLine";
import { isPathCompletionInput } from "./pathProvider";

const STATIC_COMMANDS = [
  "ls", "cd", "pwd", "cat", "grep", "find", "chmod", "chown", "mkdir", "rm", "cp", "mv",
  "git", "docker", "kubectl", "npm", "pnpm", "yarn", "node", "python", "curl", "wget",
  "ssh", "scp", "tar", "zip", "unzip", "systemctl", "journalctl", "ps", "top", "htop",
];

const GIT_SUBCOMMANDS = ["status", "log", "diff", "add", "commit", "push", "pull", "checkout", "branch", "merge", "rebase", "stash"];
const DOCKER_SUBCOMMANDS = ["ps", "images", "logs", "exec", "run", "stop", "start", "restart", "compose", "build", "pull", "push"];
const NPM_SUBCOMMANDS = ["install", "run", "test", "build", "start", "ci", "publish"];

const COMMAND_TEMPLATES: Record<string, string[]> = {
  git: GIT_SUBCOMMANDS,
  docker: DOCKER_SUBCOMMANDS,
  npm: NPM_SUBCOMMANDS,
  pnpm: NPM_SUBCOMMANDS,
  yarn: NPM_SUBCOMMANDS,
};

export function suggestTemplates(ctx: TerminalCompletionContext): CompletionCandidate[] {
  // 路径命令场景交给 path provider，避免 Tab 混入命令名/历史式候选
  if (isPathCompletionInput(ctx)) return [];

  const parsed = parseCommandLineForCompletion(ctx.input, ctx.cursor);
  const token = parsed.activeToken;
  if (!token) return [];

  const replacement = buildReplacementRange(token, ctx.cursor);
  const prefix = token.text.toLowerCase();

  if (token.kind === "command" || (parsed.tokens.length === 1 && token === parsed.tokens[0])) {
    return STATIC_COMMANDS.filter((cmd) => !prefix || cmd.startsWith(prefix)).slice(0, 15).map((cmd) => ({
      id: `cmd:${cmd}`,
      label: cmd,
      insertText: cmd,
      description: "常用命令",
      source: "template",
      priority: "default",
      replacement,
    }));
  }

  const root = parsed.tokens[0]?.text.toLowerCase();
  const subs = root ? COMMAND_TEMPLATES[root] : undefined;
  if (!subs || token.kind === "path" || token.kind === "resource") return [];

  return subs
    .filter((sub) => !prefix || sub.startsWith(prefix))
    .map((sub) => ({
      id: `tpl:${root}:${sub}`,
      label: sub,
      insertText: sub,
      description: `${root} 子命令`,
      source: "template",
      priority: "high",
      replacement,
    }));
}
