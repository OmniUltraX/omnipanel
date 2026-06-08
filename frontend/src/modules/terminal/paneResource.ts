import { resolveResourceById } from "../../stores/connectionStore";
import type { TerminalPane } from "../../stores/terminalStore";

export const LOCAL_TERMINAL_RESOURCE_ID = "local-terminal";

/** 根据资源 id 生成窗格连接字段（切换本地 / SSH 时使用） */
export function buildPaneResourcePatch(
  resourceId: string,
): Pick<
  TerminalPane,
  "type" | "resourceId" | "title" | "shellLabel" | "cwd" | "purpose" | "commandPack"
> {
  if (resourceId === LOCAL_TERMINAL_RESOURCE_ID) {
    return {
      type: "local",
      resourceId: LOCAL_TERMINAL_RESOURCE_ID,
      title: "本地终端",
      shellLabel: "Shell",
      cwd: "~/",
      purpose: "Local Workspace",
      commandPack: [],
    };
  }

  const resource = resolveResourceById(resourceId);
  return {
    type: "remote",
    resourceId,
    title: resource?.name ?? "SSH",
    shellLabel: "SSH",
    cwd: "~/",
    purpose: "SSH Workbench",
    commandPack: [],
  };
}
