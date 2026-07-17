import { commands } from "../ipc/bindings";
import {
  acquireSshPoolSession,
  releaseSshPoolSession,
} from "./sshPoolSessionStore";
import { useSshHostStore } from "./sshHostStore";
import { useSshMonitoringPrefsStore } from "./sshMonitoringPrefsStore";

/** 本进程内已成功 subscribe 的主机 */
const subscribedIds = new Set<string>();

function yieldToMain(ms = 0): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function ensureSubscribed(resourceId: string): Promise<boolean> {
  if (subscribedIds.has(resourceId)) return true;
  acquireSshPoolSession(resourceId);
  try {
    const res = await commands.sshPoolSubscribeMonitoring(resourceId);
    if (res.status !== "ok") {
      releaseSshPoolSession(resourceId);
      return false;
    }
    subscribedIds.add(resourceId);
    return true;
  } catch {
    releaseSshPoolSession(resourceId);
    return false;
  }
}

/** 开启 SSH 系统监控订阅（幂等；偏好持久化） */
export async function enableSshMonitoring(resourceId: string): Promise<void> {
  useSshMonitoringPrefsStore.getState().remember(resourceId);
  useSshHostStore.getState().setMonitoringEnabled(resourceId, true);
  const ok = await ensureSubscribed(resourceId);
  if (!ok) {
    useSshHostStore.getState().setMonitoringEnabled(resourceId, false);
  }
}

/** 关闭 SSH 系统监控订阅（幂等；清除持久化偏好） */
export async function disableSshMonitoring(resourceId: string): Promise<void> {
  useSshMonitoringPrefsStore.getState().forget(resourceId);
  if (!useSshHostStore.getState().isMonitoring(resourceId) && !subscribedIds.has(resourceId)) {
    return;
  }
  useSshHostStore.getState().setMonitoringEnabled(resourceId, false);
  if (subscribedIds.has(resourceId)) {
    subscribedIds.delete(resourceId);
    releaseSshPoolSession(resourceId);
    try {
      await commands.sshPoolUnsubscribeMonitoring(resourceId);
    } catch {
      // ignore
    }
  }
}

/**
 * 启动后恢复已记住的监控开关。
 * 必须在首屏渲染之后调用，且逐台让出主线程，避免启动卡顿。
 */
export async function restoreSshMonitoringSubscriptions(
  sshConnectionIds: Iterable<string>,
): Promise<void> {
  const prefs = useSshMonitoringPrefsStore.getState();
  const valid = new Set(sshConnectionIds);
  const remembered = [...prefs.enabledIds];
  const toRestore: string[] = [];

  for (const id of remembered) {
    if (!valid.has(id)) {
      prefs.forget(id);
      continue;
    }
    toRestore.push(id);
  }

  if (toRestore.length === 0) return;

  // 一次写完 UI 开关，避免 N 次 hosts 更新拖垮首屏
  useSshHostStore.getState().setMonitoringEnabledBulk(toRestore, true);

  const failed: string[] = [];
  for (const id of toRestore) {
    const ok = await ensureSubscribed(id);
    if (!ok) {
      failed.push(id);
    } else {
      // 建连+拉一次指标（后台），失败不影响开关偏好
      try {
        const res = await commands.sshPoolFetchStats(id);
        if (res.status === "ok") {
          const { useSshStatsStore } = await import("./sshStatsStore");
          useSshStatsStore.getState().setStats([res.data]);
        }
      } catch {
        // ignore
      }
    }
    // 让出事件循环，保证标题栏拖拽 / 窗口按钮可响应
    await yieldToMain(80);
  }

  if (failed.length > 0) {
    useSshHostStore.getState().setMonitoringEnabledBulk(failed, false);
  }
}

/** 连接删除时清理偏好与订阅状态 */
export function forgetSshMonitoring(resourceId: string): void {
  useSshMonitoringPrefsStore.getState().forget(resourceId);
  subscribedIds.delete(resourceId);
  useSshHostStore.getState().setMonitoringEnabled(resourceId, false);
}
