import type { TerminalSessionInfo } from "../../stores/terminalStore";

export const LOCAL_TERMINAL_RESOURCE_ID = "local-terminal";

/** 根据资源 id 生成会话连接字段（切换本地 / SSH 时使用） */
export function buildSessionInfoForResource(resourceId: string): TerminalSessionInfo {
  if (resourceId === LOCAL_TERMINAL_RESOURCE_ID) {
    return {
      type: "local",
      resourceId: LOCAL_TERMINAL_RESOURCE_ID,
      shellLabel: "Shell",
      cwd: "~/",
      purpose: "Local Workspace",
      commandPack: [],
    };
  }
  return {
    type: "remote",
    resourceId,
    shellLabel: "SSH",
    cwd: "~/",
    purpose: "SSH Workbench",
    commandPack: [],
  };
}
