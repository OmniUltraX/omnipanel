import { ModuleContextProvider } from "../../../lib/ai/context";
import type { DockerModuleContext } from "./types";
import { isDockerModuleContextEmpty } from "./types";

export class DockerModuleContextProvider extends ModuleContextProvider<DockerModuleContext> {
  constructor() {
    super("docker");
  }

  formatContextForAi(context: DockerModuleContext): string {
    if (isDockerModuleContextEmpty(context)) return "";
    const lines = ["## Docker 模块上下文"];
    if (context.connectionId) {
      lines.push(`- 连接 ID：${context.connectionId}`);
    }
    if (context.connectionName) {
      lines.push(`- 连接名称：${context.connectionName}`);
    }
    if (context.navKey) {
      lines.push(`- 当前导航：${context.navKey}`);
    }
    if (context.containerId) {
      lines.push(`- 容器 ID：${context.containerId}`);
    }
    if (context.containerName) {
      lines.push(`- 容器名称：${context.containerName}`);
    }
    return lines.join("\n");
  }
}

export const dockerModuleContextProvider = new DockerModuleContextProvider();
