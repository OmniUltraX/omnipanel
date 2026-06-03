import { commands } from "../ipc/bindings";

/** 连接池会话引用计数：概览 / 监控等页签共享同一 SSH 会话。 */
const refs: Record<string, number> = {};

export function acquireSshPoolSession(resourceId: string) {
  refs[resourceId] = (refs[resourceId] ?? 0) + 1;
}

export function releaseSshPoolSession(resourceId: string) {
  const next = (refs[resourceId] ?? 1) - 1;
  if (next <= 0) {
    delete refs[resourceId];
    void commands.sshPoolRelease(resourceId);
  } else {
    refs[resourceId] = next;
  }
}
