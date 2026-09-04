import { formatIpcError, isAuthIpcError } from "../../../ipc/result";

/** 认证失败后拦住自动探测 / 轮询 / 重连，改密码或手动刷新后再试。 */
const holds = new Map<string, string>();

export function noteSshAuthFailure(resourceId: string, error: unknown): boolean {
  if (!resourceId || !isAuthIpcError(error)) return false;
  holds.set(resourceId, formatIpcError(error));
  return true;
}

export function sshAuthHeldMessage(resourceId: string | null | undefined): string | null {
  if (!resourceId) return null;
  return holds.get(resourceId) ?? null;
}

export function isSshAuthHeld(resourceId: string | null | undefined): boolean {
  return sshAuthHeldMessage(resourceId) != null;
}

export function clearSshAuthHold(resourceId: string | null | undefined): void {
  if (!resourceId) return;
  holds.delete(resourceId);
}
