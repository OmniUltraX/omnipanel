import { commands } from "../ipc/bindings";
import { unwrapCommand } from "../ipc/result";
import { checkCommand } from "./commandGuard";
import { ACTION_SSH_EXEC, ACTION_SSH_KILL, pipeTarget } from "./presenceTargets";
import { requireStepUp } from "./stepUp";

export type SshPresenceHint = {
  title?: string;
  message?: string;
};

const leasedTargets = new Set<string>();

/** 与后端 `ssh_command_is_critical` 对齐：这些命令不带 token 会被拒绝。 */
export function sshCommandIsCritical(command: string): boolean {
  const compact = command.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  if (
    compact.includes("rm ") &&
    (compact.includes("-rf") ||
      compact.includes("-fr") ||
      compact.includes("--recursive") ||
      compact.includes("--force"))
  ) {
    return true;
  }
  if (compact.includes(">/dev/sd") || compact.includes("mkfs.")) return true;
  if (compact.includes("dd ") && compact.includes("of=/dev")) return true;
  if (compact.includes(":(){")) return true;
  if (compact.includes("format-volume")) return true;
  if (
    compact.includes("remove-item") &&
    compact.includes("-recurse") &&
    compact.includes("-force")
  ) {
    return true;
  }
  return false;
}

export function sshCommandNeedsPresence(command: string): boolean {
  return sshCommandIsCritical(command) || checkCommand(command).level === "critical";
}

function redactCommandPreview(command: string): string {
  const redacted = command
    .replace(/(-password\s+)(?:'[^']*'|"[^"]*"|\S+)/gi, "$1'***'")
    .replace(/(--password=)(?:'[^']*'|"[^"]*"|\S+)/gi, "$1***");
  return redacted.length > 240 ? `${redacted.slice(0, 240)}…` : redacted;
}

function leaseKey(action: string, target: string): string {
  return `${action}\n${target}`;
}

export class SshPresenceCancelledError extends Error {
  constructor() {
    super("已取消在场验证");
    this.name = "SshPresenceCancelledError";
  }
}

export async function resolveSshExecToken(
  resourceId: string,
  command: string,
  hint?: SshPresenceHint,
): Promise<string | null | undefined> {
  if (!sshCommandNeedsPresence(command)) return undefined;
  const verb = command.trim().split(/\s+/)[0] ?? "exec";
  const target = pipeTarget(resourceId, verb);
  const key = leaseKey(ACTION_SSH_EXEC, target);
  if (leasedTargets.has(key)) {
    try {
      const issued = await unwrapCommand(commands.presenceIssueLeased(ACTION_SSH_EXEC, target));
      return issued.token;
    } catch {
      leasedTargets.delete(key);
    }
  }
  const token = await requireStepUp({
    action: ACTION_SSH_EXEC,
    target,
    title: hint?.title ?? "危险命令在场验证",
    message:
      hint?.message ??
      `即将在远程主机执行高危命令：\n${redactCommandPreview(command)}`,
    reason: hint?.message ?? redactCommandPreview(command),
  });
  if (token) leasedTargets.add(key);
  return token;
}

export async function sshPoolExecWithPresence(
  resourceId: string,
  command: string,
  hint?: SshPresenceHint,
): ReturnType<typeof commands.sshPoolExecCommand> {
  const token = await resolveSshExecToken(resourceId, command, hint);
  if (token === null) {
    throw new SshPresenceCancelledError();
  }
  return commands.sshPoolExecCommand(resourceId, command, token ?? null);
}

export async function resolveSshKillToken(
  resourceId: string,
  pid: number,
): Promise<string | null> {
  return requireStepUp({
    action: ACTION_SSH_KILL,
    target: pipeTarget(resourceId, String(pid)),
    title: "终止进程",
    message: `即将强制结束远程进程 PID ${pid}`,
    reason: `kill ${pid}`,
  });
}
