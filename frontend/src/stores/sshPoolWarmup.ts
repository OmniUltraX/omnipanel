import { commands } from "../ipc/bindings";

export type SshPoolWarmSummary = {
  total: number;
  ready: number;
  failed: number;
  skipped: number;
};

/**
 * 应用启动时预热 SSH 连接池：为端口可达的主机各建立一条可用会话。
 * 失败不抛错（单台不通不影响启动），由调用方决定如何展示摘要。
 */
export async function warmAllSshPoolSessions(): Promise<SshPoolWarmSummary | null> {
  try {
    const res = await commands.sshPoolEnsureAllSessions();
    if (res.status === "ok") {
      return res.data;
    }
    console.warn("[ssh-pool] 预热失败:", res.error.message);
    return null;
  } catch (error) {
    // 非 Tauri 环境或后端尚未就绪时忽略
    console.warn("[ssh-pool] 预热跳过:", error);
    return null;
  }
}
