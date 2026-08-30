import { checkCommand } from "./commandGuard";
import { ACTION_SSH_EXEC, ACTION_SSH_KILL, pipeTarget } from "./presenceTargets";
import { requireStepUp } from "./stepUp";

export function sshCommandNeedsPresence(command: string): boolean {
  return checkCommand(command).level === "critical";
}

export async function resolveSshExecToken(
  resourceId: string,
  command: string,
): Promise<string | null | undefined> {
  if (!sshCommandNeedsPresence(command)) return undefined;
  const verb = command.trim().split(/\s+/)[0] ?? "exec";
  return requireStepUp({
    action: ACTION_SSH_EXEC,
    target: pipeTarget(resourceId, verb),
    title: "危险命令在场验证",
    message: `即将在远程主机执行高危命令：\n${command}`,
    reason: command,
  });
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
