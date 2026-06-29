import { ModuleContextProvider } from "../../../lib/ai/context";
import type { DatabaseModuleContext } from "./types";
import { isDatabaseModuleContextEmpty } from "./types";

export class DatabaseModuleContextProvider extends ModuleContextProvider<DatabaseModuleContext> {  constructor() {
    super("database");
  }

  formatContextForAi(context: DatabaseModuleContext): string {
    if (isDatabaseModuleContextEmpty(context)) {
      return "";
    }

    const lines = ["## 数据库模块上下文"];

    if (context.connection) {
      const conn = context.connection;
      lines.push(
        `- 连接名称：${conn.name}`,
        `- 连接 ID：${conn.id}`,
        `- 引擎：${conn.dbType}`,
        `- 地址：${conn.host}:${conn.port}`,
        `- 用户：${conn.user}`,
        `- 默认库：${conn.defaultDatabase || "（未指定）"}`,
        `- 分组：${conn.group}`,
        `- SSL：${conn.ssl ? "是" : "否"}`,
        `- 状态：${conn.status}`,
        `- 启用：${conn.enabled ? "是" : "否"}`,
      );
    }

    if (context.database) {
      lines.push(`- 当前数据库：${context.database}`);
    }

    return lines.join("\n");
  }
}
/** 数据库模块全局单例，由 DatabaseModuleContextBridge 维护生命周期 */
export const databaseModuleContextProvider = new DatabaseModuleContextProvider();
