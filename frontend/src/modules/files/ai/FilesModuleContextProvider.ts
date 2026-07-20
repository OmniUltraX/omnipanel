import { ModuleContextProvider } from "../../../lib/ai/context";
import type { FilesModuleContext } from "./types";
import { isFilesModuleContextEmpty } from "./types";

export class FilesModuleContextProvider extends ModuleContextProvider<FilesModuleContext> {
  constructor() {
    super("files");
  }

  formatContextForAi(context: FilesModuleContext): string {
    if (isFilesModuleContextEmpty(context)) return "";
    const lines = ["## 文件模块上下文"];
    if (context.connectionId) {
      lines.push(`- 连接 ID：${context.connectionId}`);
    }
    if (context.connectionName) {
      lines.push(`- 连接名称：${context.connectionName}`);
    }
    if (context.currentPath) {
      lines.push(`- 当前路径：${context.currentPath}`);
    }
    return lines.join("\n");
  }
}

export const filesModuleContextProvider = new FilesModuleContextProvider();
